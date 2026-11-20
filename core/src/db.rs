use anyhow::Result;
use chrono::{DateTime, SecondsFormat, Utc};
use sqlx::{
    Row, SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
};
use std::{path::Path, sync::Once, time::Duration};

pub fn timestamp(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Micros, true)
}

pub fn embedding_blob(values: &[f64]) -> Result<Vec<u8>> {
    anyhow::ensure!(
        values.len() == 3072
            && values
                .iter()
                .all(|x| x.is_finite() && (*x as f32).is_finite()),
        "Expected 3072 finite embedding dimensions"
    );
    Ok(values
        .iter()
        .flat_map(|x| (*x as f32).to_le_bytes())
        .collect())
}

fn register_vectors() {
    static REGISTER: Once = Once::new();
    REGISTER.call_once(|| unsafe {
        let result = libsqlite3_sys::sqlite3_auto_extension(Some(std::mem::transmute::<
            *const (),
            unsafe extern "C" fn(
                *mut libsqlite3_sys::sqlite3,
                *mut *mut std::ffi::c_char,
                *const libsqlite3_sys::sqlite3_api_routines,
            ) -> std::ffi::c_int,
        >(
            sqlite_vec::sqlite3_vec_init as *const (),
        )));
        assert_eq!(result, libsqlite3_sys::SQLITE_OK);
    });
}

pub async fn read_only_pool(path: &Path) -> Result<SqlitePool> {
    register_vectors();
    Ok(SqlitePoolOptions::new()
        .max_connections(2)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(path)
                .read_only(true)
                .foreign_keys(true)
                .busy_timeout(Duration::from_secs(5))
                .pragma("query_only", "ON"),
        )
        .await?)
}

pub async fn pool(path: &str, test: bool) -> Result<SqlitePool> {
    register_vectors();
    if let Some(parent) = Path::new(path)
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
    {
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(parent)?;
    }
    let mut file = std::fs::OpenOptions::new();
    file.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        file.mode(0o600);
    }
    match file.open(path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5))
        .synchronous(SqliteSynchronous::Full);
    Ok(SqlitePoolOptions::new()
        .max_connections(if test { 2 } else { 12 })
        .connect_with(options)
        .await?)
}

pub async fn migrate(pool: &SqlitePool, directory: &Path) -> Result<()> {
    let mut transaction = pool.begin_with("BEGIN IMMEDIATE").await?;
    sqlx::query("create table if not exists sent_migrations (filename text primary key not null, applied_at text not null default (strftime('%Y-%m-%dT%H:%M:%f000Z','now')))").execute(&mut *transaction).await?;
    let applied = sqlx::query("select filename from sent_migrations")
        .fetch_all(&mut *transaction)
        .await?
        .into_iter()
        .map(|r| r.get::<String, _>("filename"))
        .collect::<Vec<_>>();
    let mut entries = tokio::fs::read_dir(directory).await?;
    let mut files = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        if entry.file_type().await?.is_file()
            && entry.path().extension().is_some_and(|x| x == "sql")
        {
            files.push(entry.file_name().to_string_lossy().into_owned());
        }
    }
    files.sort();
    for file in files {
        if applied.contains(&file) {
            continue;
        }
        let sql = tokio::fs::read_to_string(directory.join(&file)).await?;
        sqlx::raw_sql(&sql).execute(&mut *transaction).await?;
        sqlx::query("insert into sent_migrations(filename) values (?1)")
            .bind(&file)
            .execute(&mut *transaction)
            .await?;
        println!("Applied {file}");
    }
    transaction.commit().await?;
    Ok(())
}

#[derive(
    Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Hash, serde::Serialize, serde::Deserialize,
)]
#[serde(transparent)]
pub struct Uuid(uuid::Uuid);

impl Uuid {
    pub fn new_v4() -> Self {
        Self(uuid::Uuid::new_v4())
    }
    pub const fn nil() -> Self {
        Self(uuid::Uuid::nil())
    }
    pub const fn from_u128(value: u128) -> Self {
        Self(uuid::Uuid::from_u128(value))
    }
}

impl std::fmt::Display for Uuid {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

impl std::str::FromStr for Uuid {
    type Err = uuid::Error;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        value.parse().map(Self)
    }
}

impl sqlx::Type<sqlx::Sqlite> for Uuid {
    fn type_info() -> sqlx::sqlite::SqliteTypeInfo {
        <String as sqlx::Type<sqlx::Sqlite>>::type_info()
    }
}

impl<'q> sqlx::Encode<'q, sqlx::Sqlite> for Uuid {
    fn encode_by_ref(
        &self,
        args: &mut Vec<sqlx::sqlite::SqliteArgumentValue<'q>>,
    ) -> Result<sqlx::encode::IsNull, sqlx::error::BoxDynError> {
        <String as sqlx::Encode<sqlx::Sqlite>>::encode(self.to_string(), args)
    }
}

impl<'r> sqlx::Decode<'r, sqlx::Sqlite> for Uuid {
    fn decode(value: sqlx::sqlite::SqliteValueRef<'r>) -> Result<Self, sqlx::error::BoxDynError> {
        let text = <String as sqlx::Decode<sqlx::Sqlite>>::decode(value)?;
        Ok(text.parse()?)
    }
}
