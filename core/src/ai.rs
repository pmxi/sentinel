use crate::{config::Config, normalize::content_hash};
use anyhow::{Context, Result, bail, ensure};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const OMISSION: &str = "\n\n[... middle omitted for embedding ...]\n\n";

pub struct ReaderLinks {
    pub input: String,
    urls: Vec<String>,
}
fn url_pattern() -> Regex {
    Regex::new(r#"https?://[^\s<>\[\]"]+"#).unwrap()
}

impl ReaderLinks {
    pub fn new(message: &str) -> Self {
        let mut urls = vec![];
        for found in url_pattern().find_iter(message) {
            if !urls.iter().any(|s| s == found.as_str()) {
                urls.push(found.as_str().to_owned());
            }
        }
        let definitions = urls
            .iter()
            .enumerate()
            .map(|(i, url)| format!("[sent-link-{}]: <{url}>", i + 1))
            .collect::<Vec<_>>()
            .join("\n");
        Self {
            input: if urls.is_empty() {
                message.into()
            } else {
                format!(
                    "{message}\n\nSent link references (use these IDs for hyperlinks):\n{definitions}"
                )
            },
            urls,
        }
    }
    pub fn finish(&self, text: &str) -> Result<String> {
        for found in url_pattern().find_iter(text) {
            let url = found.as_str();
            ensure!(
                self.urls
                    .iter()
                    .any(|s| s == url || s == url.trim_end_matches([')', '.', ',', ';'])),
                "Reader rewrite contains a URL not present in the source"
            );
        }
        ensure!(
            !Regex::new(r"(?im)^\s*\[sent-link-\d+\]:")
                .unwrap()
                .is_match(text),
            "Reader rewrite must not supply its own link definitions"
        );
        let mut used = vec![];
        for capture in Regex::new(r"(?i)\]\[(sent-link-\d+)\]")
            .unwrap()
            .captures_iter(text)
        {
            let id = capture[1].to_lowercase();
            if used.contains(&id) {
                continue;
            }
            let index = id.strip_prefix("sent-link-").unwrap().parse::<usize>()?;
            let url = index
                .checked_sub(1)
                .and_then(|i| self.urls.get(i))
                .context("Reader rewrite contains an unknown link reference")?;
            used.push(id);
            let _ = url;
        }
        let links = used
            .iter()
            .map(|id| {
                let i = id[10..].parse::<usize>().unwrap() - 1;
                format!("[{id}]: <{}>", self.urls[i])
            })
            .collect::<Vec<_>>();
        Ok(if links.is_empty() {
            text.into()
        } else {
            format!("{}\n\n{}", text.trim(), links.join("\n"))
        })
    }
}

pub fn embedding_fallback_input(text: &str) -> String {
    if text.len() <= 7500 {
        return text.into();
    }
    let content = 7500 - OMISSION.len();
    let prefix = content * 72 / 100;
    let suffix = content - prefix;
    let mut p = prefix;
    while !text.is_char_boundary(p) {
        p -= 1;
    }
    let mut s = text.len() - suffix;
    while !text.is_char_boundary(s) {
        s += 1;
    }
    format!("{}{OMISSION}{}", &text[..p], &text[s..])
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassificationResult {
    pub reasoning: String,
    pub summary: String,
    pub tier: i32,
    pub plain_text: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub prompt_version: String,
}

impl ClassificationResult {
    pub fn validate(&mut self) -> Result<()> {
        self.summary = self.summary.trim().into();
        ensure!(
            !self.reasoning.is_empty()
                && (1..=3).contains(&self.tier)
                && !self.summary.is_empty()
                && self.summary.encode_utf16().count() <= 280
                && self.plain_text.encode_utf16().count() <= 20000,
            "Invalid classification output"
        );
        Ok(())
    }
}

#[derive(Clone)]
pub struct Intelligence {
    config: Config,
    http: reqwest::Client,
    base: String,
}
impl Intelligence {
    pub fn new(config: Config) -> Self {
        Self::with_base_url(config, "https://api.openai.com/v1".into())
    }
    pub fn with_base_url(config: Config, base: String) -> Self {
        Self {
            config,
            base,
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(120))
                .build()
                .expect("HTTP client"),
        }
    }
    async fn request(&self, path: &str, body: Value) -> Result<Value> {
        let key = Config::required(&self.config.openai_api_key, "OPENAI_API_KEY")?;
        let response = self
            .http
            .post(format!("{}{path}", self.base))
            .bearer_auth(key)
            .json(&body)
            .send()
            .await?;
        let status = response.status();
        let text = response.text().await?;
        ensure!(
            status.is_success(),
            "OpenAI HTTP {}: {}",
            status.as_u16(),
            text.chars().take(1000).collect::<String>()
        );
        Ok(serde_json::from_str(&text)?)
    }
    pub async fn classify(&self, message: &str) -> Result<ClassificationResult> {
        let prompt = include_str!("../../prompts/classify-v1.md");
        let links = ReaderLinks::new(message);
        let response=self.request("/responses",json!({"model":self.config.classification_model,"instructions":prompt,"input":links.input,"reasoning":{"effort":"xhigh"},"store":false,"text":{"format":{"type":"json_schema","name":"email_classification","strict":true,"schema":{"type":"object","properties":{"reasoning":{"type":"string","minLength":1},"summary":{"type":"string","minLength":1,"maxLength":280},"tier":{"type":"number","enum":[1,2,3]},"plainText":{"type":"string","maxLength":20000}},"required":["reasoning","summary","tier","plainText"],"additionalProperties":false}}}})).await?;
        ensure!(
            response["status"] != "incomplete" && response["status"] != "failed",
            "OpenAI returned incomplete classification output"
        );
        let text = response["output"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|v| v["content"].as_array().into_iter().flatten())
            .find(|v| v["type"] == "output_text")
            .and_then(|v| v["text"].as_str())
            .context("OpenAI returned no classification output")?;
        let mut result: ClassificationResult = serde_json::from_str(text)?;
        result.validate()?;
        result.plain_text = links.finish(&result.plain_text)?;
        result.model = self.config.classification_model.clone();
        result.prompt_version = content_hash(prompt)[..12].into();
        Ok(result)
    }
    pub async fn embed(&self, text: &str) -> Result<(Vec<f64>, String)> {
        let input = if text.encode_utf16().count() <= 28000 {
            text.into()
        } else {
            let chars = text.encode_utf16().collect::<Vec<_>>();
            format!(
                "{}{OMISSION}{}",
                String::from_utf16_lossy(&chars[..20000]),
                String::from_utf16_lossy(&chars[chars.len() - 8000..])
            )
        };
        let body = |input: String| json!({"model":self.config.embedding_model,"input":input,"encoding_format":"float"});
        let response = match self.request("/embeddings", body(input)).await {
            Ok(response) => response,
            Err(error) => {
                let message = error.to_string().to_lowercase();
                if message.contains("maximum context length") || message.contains("too many tokens")
                {
                    self.request("/embeddings", body(embedding_fallback_input(text)))
                        .await?
                } else {
                    return Err(error);
                }
            }
        };
        let Some(array) = response["data"][0]["embedding"].as_array() else {
            bail!("OpenAI returned no embedding");
        };
        Ok((
            array
                .iter()
                .map(|v| v.as_f64().context("Invalid embedding value"))
                .collect::<Result<_>>()?,
            self.config.embedding_model.clone(),
        ))
    }
}
