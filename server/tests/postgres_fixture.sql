-- Isolated test database only, after applying the original PostgreSQL migrations.
BEGIN;
CREATE FUNCTION pg_temp.fixture_id(text) RETURNS uuid LANGUAGE sql IMMUTABLE AS
  'SELECT overlay(overlay(md5($1) placing ''4'' from 13) placing ''8'' from 17)::uuid';
INSERT INTO accounts(id,provider,email,display_name,encrypted_credentials,last_synced_at)
SELECT pg_temp.fixture_id('account-'||n), CASE WHEN n=1 THEN 'gmail' ELSE 'microsoft' END::provider,
  'owner'||n||'@example.test','Fixture Owner '||n,'fixture-only',now() FROM generate_series(1,2) n;
INSERT INTO sync_cursors(account_id,cursor,backfill_complete,last_successful_at)
SELECT id,'fixture-cursor',true,now() FROM accounts;
INSERT INTO threads(id,account_id,provider_thread_id,subject,last_message_at)
SELECT pg_temp.fixture_id('thread-'||n),pg_temp.fixture_id('account-'||(n%2+1)),'thread-'||n,'Meeting '||n,now()-n*interval '1 minute'
FROM generate_series(1,500) n;
INSERT INTO messages(id,account_id,thread_id,provider_message_id,internet_message_id,subject,
 from_addresses,to_addresses,cc_addresses,sent_at,received_at,snippet,text_body,html_body,headers,attachments,
 direction,read,flagged,archived,deleted,tombstone,native_state,provider_updated_at)
SELECT pg_temp.fixture_id('message-'||n),pg_temp.fixture_id('account-'||(((n-1)%500+1)%2+1)),
 pg_temp.fixture_id('thread-'||((n-1)%500+1)),'message-'||n,'<fixture-'||n||'@example.test>',
 'The meeting project '||n,jsonb_build_array(jsonb_build_object('name','Zoë 東京','email','sender@example.test')),
 '[{"name":"Owner","email":"owner1@example.test"}]'::jsonb,'[]'::jsonb,
 '2026-01-02T03:04:05.123456Z'::timestamptz-n*interval '1 minute',
 '2026-01-02T03:05:05.654321Z'::timestamptz-n*interval '1 minute',
 'The meeting update','The project meeting notes — café '||repeat('body text ',200),
 CASE WHEN n%4=0 THEN NULL ELSE '<p>The meeting</p>' END,
 '{"X-Fixture":"yes"}'::jsonb,CASE WHEN n%7=0 THEN '[{"filename":"report.pdf","size":42}]'::jsonb ELSE '[]'::jsonb END,
 CASE WHEN n%11=0 THEN 'outbound' ELSE 'inbound' END::message_direction,
 n%2=0,n%3=0,n%5=0,n%13=0,n%17=0,'{"labels":["INBOX"]}'::jsonb,now()
FROM generate_series(1,1000) n;
INSERT INTO provider_containers(account_id,provider_id,name,kind,metadata)
SELECT id,'INBOX','Inbox','system','{"fixture":true}'::jsonb FROM accounts;
INSERT INTO message_containers SELECT id,account_id,'INBOX' FROM messages;
INSERT INTO classifications(message_id,model_tier,reasoning,plain_text,summary,manual_tier,model,prompt_version)
SELECT pg_temp.fixture_id('message-'||n),n%3+1,'Fixture reason',CASE WHEN n%2=0 THEN NULL ELSE 'Plain fixture' END,
 'Fixture summary',CASE WHEN n%7=0 THEN 1 ELSE NULL END,'fixture','v1' FROM generate_series(1,800) n;
INSERT INTO classification_failures(message_id,attempts,last_error)
SELECT pg_temp.fixture_id('message-'||n),2,'Fixture failure' FROM generate_series(801,810) n;
INSERT INTO embeddings(message_id,embedding,model,content_hash)
SELECT pg_temp.fixture_id('message-'||n),
 ('['||(SELECT string_agg(((sin(d+n)*0.1)::real)::text,',' ORDER BY d) FROM generate_series(1,3072) d)||']')::vector,
 'fixture-embedding','fixture-hash-'||n FROM generate_series(1,400) n;
INSERT INTO drafts(id,account_id,to_addresses,subject,body,reply_to_message_id)
SELECT pg_temp.fixture_id('draft-'||n),pg_temp.fixture_id('account-1'),'[{"email":"reply@example.test"}]'::jsonb,
 'Fixture draft','Draft body',pg_temp.fixture_id('message-'||n) FROM generate_series(1,3) n;
INSERT INTO mutation_outbox(id,idempotency_key,account_id,message_id,action,payload,status,completed_at)
SELECT pg_temp.fixture_id('mutation-'||n),'fixture-mutation-'||n,pg_temp.fixture_id('account-1'),pg_temp.fixture_id('message-'||n),
 'archive',jsonb_build_object('archived',true,'nested',jsonb_build_array(1,'two',NULL)),
 CASE WHEN n=1 THEN 'complete' ELSE 'pending' END::mutation_status,CASE WHEN n=1 THEN now() ELSE NULL END
FROM generate_series(1,4) n;
INSERT INTO worker_state(name,metadata) VALUES('worker','{"fixture":true}');
COMMIT;
