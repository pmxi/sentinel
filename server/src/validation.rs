use axum::{
    Json,
    extract::{FromRequest, FromRequestParts, Request},
    http::{StatusCode, request::Parts},
    response::{IntoResponse, Response},
};
use chrono::{DateTime, NaiveDate, TimeZone, Utc};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

pub enum Schema {
    String {
        min: usize,
        max: Option<usize>,
        trim: bool,
        format: Option<&'static str>,
    },
    Enum(&'static [&'static str]),
    Bool,
    CoerceBool,
    Tier,
    Number,
    Date,
    Array(Box<Schema>),
    Object(Vec<(&'static str, Schema)>),
    Optional(Box<Schema>),
    Default(Box<Schema>, Value),
    Nullable(Box<Schema>),
}

pub trait Validated {
    fn schema() -> Schema;
}
pub struct ZodJson<T>(pub T);
pub struct ZodQuery<T>(pub T);

pub fn string(min: usize, max: Option<usize>) -> Schema {
    Schema::String {
        min,
        max,
        trim: false,
        format: None,
    }
}
pub fn uuid() -> Schema {
    Schema::String {
        min: 0,
        max: None,
        trim: false,
        format: Some("uuid"),
    }
}
pub fn optional(schema: Schema) -> Schema {
    Schema::Optional(Box::new(schema))
}
pub fn default(schema: Schema, value: Value) -> Schema {
    Schema::Default(Box::new(schema), value)
}
pub fn nullable(schema: Schema) -> Schema {
    Schema::Nullable(Box::new(schema))
}

fn invalid(expected: &str, value: Option<&Value>, path: &[Value]) -> Value {
    let received = match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    };
    json!({"expected":expected,"code":"invalid_type","path":path,"message":format!("Invalid input: expected {expected}, received {received}")})
}

fn issue_limit(origin: &str, count: usize, minimum: bool, path: &[Value]) -> Value {
    let comparison = if minimum { ">=" } else { "<=" };
    let message = if origin == "string" {
        format!(
            "Too {}: expected string to have {comparison}{count} characters",
            if minimum { "small" } else { "big" }
        )
    } else {
        format!(
            "Too {}: expected number to be {comparison}{count}",
            if minimum { "small" } else { "big" }
        )
    };
    let mut value = json!({"origin":origin,"code":if minimum{"too_small"}else{"too_big"},"inclusive":true,"path":path,"message":message});
    value[if minimum { "minimum" } else { "maximum" }] = json!(count);
    value
}

const UUID_PATTERN: &str = "/^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/";
const EMAIL_PATTERN: &str = "/^(?!\\.)(?!.*\\.\\.)([A-Za-z0-9_'+\\-\\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$/";

fn formatted(format: &str, text: &str) -> bool {
    if format == "uuid" {
        let Ok(id) = uuid::Uuid::parse_str(text) else {
            return false;
        };
        if text.len() != 36 {
            return false;
        }
        return id.is_nil()
            || id == uuid::Uuid::max()
            || (matches!(text.as_bytes()[14], b'1'..=b'8')
                && matches!(
                    text.as_bytes()[19].to_ascii_lowercase(),
                    b'8' | b'9' | b'a' | b'b'
                ));
    }
    let Some((local, domain)) = text.split_once('@') else {
        return false;
    };
    !local.is_empty()
        && !local.starts_with('.')
        && !local.ends_with('.')
        && !local.contains("..")
        && local
            .as_bytes()
            .last()
            .is_some_and(|b| b.is_ascii_alphanumeric() || b"_+-".contains(b))
        && local
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_'+-.".contains(&b))
        && domain.split('.').count() >= 2
        && domain.split('.').all(|s| {
            !s.is_empty()
                && s.as_bytes()[0].is_ascii_alphanumeric()
                && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
        && domain
            .rsplit('.')
            .next()
            .is_some_and(|s| s.len() >= 2 && s.bytes().all(|b| b.is_ascii_alphabetic()))
}

impl Schema {
    fn parse(
        &self,
        value: Option<&Value>,
        path: &[Value],
        issues: &mut Vec<Value>,
    ) -> Option<Value> {
        match self {
            Self::Optional(schema) if value.is_some() => schema.parse(value, path, issues),
            Self::Optional(_) => None,
            Self::Default(schema, default) => schema.parse(value.or(Some(default)), path, issues),
            Self::Nullable(_) if value == Some(&Value::Null) => Some(Value::Null),
            Self::Nullable(schema) => schema.parse(value, path, issues),
            Self::Object(fields) => {
                let Some(Value::Object(object)) = value else {
                    issues.push(invalid("object", value, path));
                    return None;
                };
                let mut result = serde_json::Map::new();
                for (name, schema) in fields {
                    let mut next = path.to_vec();
                    next.push(json!(name));
                    if let Some(value) = schema.parse(object.get(*name), &next, issues) {
                        result.insert((*name).into(), value);
                    }
                }
                Some(Value::Object(result))
            }
            Self::Array(schema) => {
                let Some(Value::Array(array)) = value else {
                    issues.push(invalid("array", value, path));
                    return None;
                };
                Some(Value::Array(
                    array
                        .iter()
                        .enumerate()
                        .filter_map(|(index, value)| {
                            let mut next = path.to_vec();
                            next.push(json!(index));
                            schema.parse(Some(value), &next, issues)
                        })
                        .collect(),
                ))
            }
            Self::String {
                min,
                max,
                trim,
                format,
            } => {
                let Some(Value::String(text)) = value else {
                    issues.push(invalid("string", value, path));
                    return None;
                };
                let text = if *trim { text.trim() } else { text };
                let count = text.encode_utf16().count();
                if count < *min {
                    issues.push(issue_limit("string", *min, true, path));
                }
                if let Some(max) = max
                    && count > *max
                {
                    issues.push(issue_limit("string", *max, false, path));
                }
                if let Some(format) = format
                    && !formatted(format, text)
                {
                    issues.push(json!({"origin":"string","code":"invalid_format","format":format,"pattern":if *format=="uuid"{UUID_PATTERN}else{EMAIL_PATTERN},"path":path,"message":if *format=="uuid"{"Invalid UUID"}else{"Invalid email address"}}));
                }
                Some(json!(text))
            }
            Self::Bool => {
                if matches!(value, Some(Value::Bool(_))) {
                    value.cloned()
                } else {
                    issues.push(invalid("boolean", value, path));
                    None
                }
            }
            Self::CoerceBool => Some(json!(match value {
                None | Some(Value::Null) => false,
                Some(Value::Bool(v)) => *v,
                Some(Value::String(v)) => !v.is_empty(),
                Some(Value::Number(v)) => v.as_f64() != Some(0.0),
                _ => true,
            })),
            Self::Enum(values) => {
                if value
                    .and_then(Value::as_str)
                    .is_some_and(|v| values.contains(&v))
                {
                    return value.cloned();
                }
                let quoted = values
                    .iter()
                    .map(|v| format!("\"{v}\""))
                    .collect::<Vec<_>>()
                    .join("|");
                issues.push(json!({"code":"invalid_value","values":values,"path":path,"message":format!("Invalid option: expected one of {quoted}")}));
                None
            }
            Self::Tier => {
                if value
                    .and_then(Value::as_i64)
                    .is_some_and(|v| (1..=3).contains(&v))
                {
                    return value.cloned();
                }
                issues.push(json!({"code":"invalid_union","errors":(1..=3).map(|tier|json!([{"code":"invalid_value","values":[tier],"path":[],"message":format!("Invalid input: expected {tier}")}])).collect::<Vec<_>>(),"path":path,"message":"Invalid input"}));
                None
            }
            Self::Number => {
                let number = match value {
                    Some(Value::Number(n)) => n.as_f64(),
                    Some(Value::String(s)) => {
                        if s.trim().is_empty() {
                            Some(0.0)
                        } else {
                            s.trim().parse().ok()
                        }
                    }
                    Some(Value::Null) => Some(0.0),
                    Some(Value::Bool(v)) => Some(if *v { 1.0 } else { 0.0 }),
                    _ => None,
                };
                let Some(number) = number.filter(|n| n.is_finite()) else {
                    issues.push(json!({"expected":"number","code":"invalid_type","received":"NaN","path":path,"message":"Invalid input: expected number, received NaN"}));
                    return None;
                };
                if number.fract() != 0.0 {
                    issues.push(json!({"expected":"int","format":"safeint","code":"invalid_type","path":path,"message":"Invalid input: expected int, received number"}));
                    return None;
                }
                if number < 1.0 {
                    issues.push(issue_limit("number", 1, true, path));
                }
                if number > 100.0 {
                    issues.push(issue_limit("number", 100, false, path));
                }
                Some(json!(number as i64))
            }
            Self::Date => {
                let parsed = value.and_then(Value::as_str).and_then(|v| {
                    DateTime::parse_from_rfc3339(v)
                        .ok()
                        .map(|d| d.with_timezone(&Utc))
                        .or_else(|| {
                            NaiveDate::parse_from_str(v, "%Y-%m-%d").ok().map(|d| {
                                Utc.from_utc_datetime(&d.and_hms_opt(0, 0, 0).expect("midnight"))
                            })
                        })
                });
                if let Some(date) = parsed {
                    Some(json!(date))
                } else {
                    issues.push(json!({"expected":"date","code":"invalid_type","received":"Invalid Date","path":path,"message":"Invalid input: expected date, received Date"}));
                    None
                }
            }
        }
    }
}

pub fn validate<T: Validated + DeserializeOwned>(value: &Value) -> Result<T, Box<Response>> {
    let mut issues = Vec::new();
    let normalized = T::schema().parse(Some(value), &[], &mut issues);
    if !issues.is_empty() {
        return Err(Box::new(
            (
                StatusCode::BAD_REQUEST,
                Json(json!({"error":"Invalid request","details":issues})),
            )
                .into_response(),
        ));
    }
    serde_json::from_value(normalized.unwrap_or(Value::Null)).map_err(|_| {
        Box::new(
            (
                StatusCode::BAD_REQUEST,
                Json(json!({"error":"Invalid request"})),
            )
                .into_response(),
        )
    })
}

pub fn path(schema: Schema, value: &Value) -> Result<(), Box<Response>> {
    let mut issues = Vec::new();
    schema.parse(Some(value), &[], &mut issues);
    if issues.is_empty() {
        Ok(())
    } else {
        Err(Box::new(
            (
                StatusCode::BAD_REQUEST,
                Json(json!({"error":"Invalid request","details":issues})),
            )
                .into_response(),
        ))
    }
}

impl<S, T> FromRequest<S> for ZodJson<T>
where
    S: Send + Sync,
    T: Validated + DeserializeOwned,
{
    type Rejection = Response;
    async fn from_request(request: Request, state: &S) -> Result<Self, Self::Rejection> {
        let Json(value) = Json::<Value>::from_request(request, state)
            .await
            .map_err(|_| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({"error":"Something went wrong"})),
                )
                    .into_response()
            })?;
        validate(&value).map(Self).map_err(|r| *r)
    }
}

impl<S, T> FromRequestParts<S> for ZodQuery<T>
where
    S: Send + Sync,
    T: Validated + DeserializeOwned,
{
    type Rejection = Response;
    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        let url = reqwest::Url::parse(&format!(
            "http://localhost/?{}",
            parts.uri.query().unwrap_or("")
        ))
        .expect("query URL");
        let mut value = serde_json::Map::new();
        for (key, item) in url.query_pairs() {
            let item = json!(item);
            if let Some(existing) = value.get_mut(key.as_ref()) {
                if let Value::Array(array) = existing {
                    array.push(item);
                } else {
                    *existing = json!([existing.clone(), item]);
                }
            } else {
                value.insert(key.into_owned(), item);
            }
        }
        validate(&Value::Object(value)).map(Self).map_err(|r| *r)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_normal_empty_and_invalid_shapes() {
        let schema = Schema::Object(vec![
            ("id", uuid()),
            ("body", default(string(0, None), json!(""))),
        ]);
        let mut issues = Vec::new();
        assert!(
            schema
                .parse(
                    Some(&json!({"id":"00000000-0000-0000-0000-000000000000"})),
                    &[],
                    &mut issues
                )
                .is_some()
        );
        assert!(issues.is_empty());
        schema.parse(Some(&json!({})), &[], &mut issues);
        assert_eq!(issues[0]["path"], json!(["id"]));
        issues.clear();
        schema.parse(Some(&Value::Null), &[], &mut issues);
        assert_eq!(issues[0]["expected"], "object");
    }
}
