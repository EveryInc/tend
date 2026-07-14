begin;
select plan(23);

insert into public.mobile_feeds (
  user_id, feed_id, position, name, generation, payload
) values
  ('00000000-0000-0000-0000-000000000001', 'inbox', 0, 'Inbox', 'pass:1', '{"id":"inbox"}'),
  ('00000000-0000-0000-0000-000000000002', 'inbox', 0, 'Other Inbox', 'pass:1', '{"id":"inbox"}');

insert into public.mobile_cards (
  user_id, feed_id, card_id, item_kind, status, reviewable, feed_generation, card_digest, payload
) values
  (
    '00000000-0000-0000-0000-000000000001',
    'inbox',
    'card-1',
    'attention',
    'to_review_new',
    true,
    'pass:1',
    'digest-1',
    '{"feedId":"inbox","cardId":"card-1","actions":[{"id":"dismiss-card","digest":"dismiss-1"},{"id":"default-cleanup","digest":"cleanup-1"}]}'
  ),
  (
    '00000000-0000-0000-0000-000000000002',
    'inbox',
    'card-2',
    'attention',
    'to_review_new',
    true,
    'pass:1',
    'digest-2',
    '{"feedId":"inbox","cardId":"card-2","actions":[]}'
  );

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

select results_eq(
  'select feed_id from public.mobile_feeds order by feed_id',
  array['inbox'::text],
  'a user sees only their feeds'
);

select results_eq(
  'select card_id from public.mobile_cards order by card_id',
  array['card-1'::text],
  'a user sees only their cards'
);

select throws_ok(
  $$insert into public.mobile_feeds (user_id, feed_id, position, name, generation, payload)
    values ('00000000-0000-0000-0000-000000000001', 'bad', 2, 'Bad', 'pass:1', '{}')$$,
  '42501',
  null,
  'authenticated clients cannot mutate feed projections'
);

select lives_ok(
  $$select public.submit_mobile_command(jsonb_build_object(
    'id', '10000000-0000-0000-0000-000000000001',
    'clientRequestId', '20000000-0000-0000-0000-000000000001',
    'deviceId', 'iphone',
    'feedId', 'inbox',
    'cardId', 'card-1',
    'feedGeneration', 'pass:1',
    'expectedCardDigest', 'digest-1',
    'kind', 'archive',
    'actionId', 'default-cleanup',
    'expectedActionDigest', 'cleanup-1'
  ))$$,
  'the authenticated user can submit an exact current command'
);

select is(
  (select count(*) from public.mobile_commands),
  1::bigint,
  'one command was created'
);

select lives_ok(
  $$select public.submit_mobile_command(jsonb_build_object(
    'id', '10000000-0000-0000-0000-000000000001',
    'clientRequestId', '20000000-0000-0000-0000-000000000001',
    'deviceId', 'iphone',
    'feedId', 'inbox',
    'cardId', 'card-1',
    'feedGeneration', 'pass:1',
    'expectedCardDigest', 'digest-1',
    'kind', 'archive',
    'actionId', 'default-cleanup',
    'expectedActionDigest', 'cleanup-1'
  ))$$,
  'replaying the same client request is idempotent'
);

select is(
  (select count(*) from public.mobile_commands),
  1::bigint,
  'an idempotent replay does not duplicate the command'
);

select lives_ok(
  $$select public.submit_mobile_command(jsonb_build_object(
    'id', '10000000-0000-0000-0000-000000000006',
    'clientRequestId', '20000000-0000-0000-0000-000000000006',
    'deviceId', 'iphone',
    'feedId', 'inbox',
    'cardId', 'card-1',
    'feedGeneration', 'pass:1',
    'expectedCardDigest', 'digest-1',
    'kind', 'dismiss',
    'actionId', 'dismiss-card',
    'expectedActionDigest', 'dismiss-1'
  ))$$,
  'the authenticated user can submit an exact local-dismiss command'
);

select lives_ok(
  $$select public.submit_mobile_command(jsonb_build_object(
    'id', '10000000-0000-0000-0000-000000000006',
    'clientRequestId', '20000000-0000-0000-0000-000000000006',
    'deviceId', 'iphone',
    'feedId', 'inbox',
    'cardId', 'card-1',
    'feedGeneration', 'pass:1',
    'expectedCardDigest', 'digest-1',
    'kind', 'dismiss',
    'actionId', 'dismiss-card',
    'expectedActionDigest', 'dismiss-1'
  ))$$,
  'replaying the same local-dismiss request is idempotent'
);

select is(
  (select count(*) from public.mobile_commands),
  2::bigint,
  'local dismissal and source cleanup remain distinct commands'
);

select cmp_ok(
  (select available_at from public.mobile_commands where id = '10000000-0000-0000-0000-000000000006'),
  '>',
  (select created_at from public.mobile_commands where id = '10000000-0000-0000-0000-000000000006'),
  'local dismissal retains the brief server-side undo window'
);

select throws_ok(
  $$select public.submit_mobile_command(jsonb_build_object(
    'id', '10000000-0000-0000-0000-000000000007',
    'clientRequestId', '20000000-0000-0000-0000-000000000007',
    'deviceId', 'iphone',
    'feedId', 'inbox',
    'cardId', 'card-1',
    'feedGeneration', 'pass:1',
    'expectedCardDigest', 'digest-1',
    'kind', 'dismiss',
    'actionId', 'dismiss-card',
    'expectedActionDigest', 'stale-dismiss'
  ))$$,
  'P0001',
  'selected action changed after review',
  'local dismissal rejects a stale action digest'
);

select is(
  (select state::text from public.cancel_mobile_command('10000000-0000-0000-0000-000000000006')),
  'cancelled',
  'local dismissal can be cancelled during its undo window'
);

reset role;

update public.mobile_cards
set feed_generation = 'pass:2',
    card_digest = 'digest-new'
where user_id = '00000000-0000-0000-0000-000000000001'
  and feed_id = 'inbox'
  and card_id = 'card-1';

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

select lives_ok(
  $$select public.submit_mobile_command(jsonb_build_object(
    'id', '10000000-0000-0000-0000-000000000001',
    'clientRequestId', '20000000-0000-0000-0000-000000000001',
    'deviceId', 'iphone',
    'feedId', 'inbox',
    'cardId', 'card-1',
    'feedGeneration', 'pass:1',
    'expectedCardDigest', 'digest-1',
    'kind', 'archive',
    'actionId', 'default-cleanup',
    'expectedActionDigest', 'cleanup-1'
  ))$$,
  'an accepted request remains replayable after the mirrored card advances'
);

reset role;

update public.mobile_cards
set feed_generation = 'pass:1',
    card_digest = 'digest-1'
where user_id = '00000000-0000-0000-0000-000000000001'
  and feed_id = 'inbox'
  and card_id = 'card-1';

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

select throws_ok(
  $$select public.submit_mobile_command(jsonb_build_object(
    'id', '10000000-0000-0000-0000-000000000002',
    'clientRequestId', '20000000-0000-0000-0000-000000000002',
    'deviceId', 'iphone',
    'feedId', 'inbox',
    'cardId', 'card-1',
    'feedGeneration', 'pass:1',
    'expectedCardDigest', 'stale',
    'kind', 'instruction',
    'instruction', 'Do something'
  ))$$,
  'P0001',
  'card changed after review',
  'stale cards are rejected'
);

select throws_ok(
  $$select public.submit_mobile_command(jsonb_build_object(
    'id', '10000000-0000-0000-0000-000000000003',
    'clientRequestId', '20000000-0000-0000-0000-000000000003',
    'deviceId', 'iphone',
    'feedId', 'inbox',
    'cardId', 'card-2',
    'feedGeneration', 'pass:1',
    'expectedCardDigest', 'digest-2',
    'kind', 'instruction',
    'instruction', 'Cross user'
  ))$$,
  'P0001',
  'card is no longer available',
  'another user card cannot be commanded'
);

select is(
  (select state::text from public.mobile_commands limit 1),
  'pending',
  'new commands remain pending for the local Tend worker'
);

select is(
  (select state::text from public.cancel_mobile_command('10000000-0000-0000-0000-000000000001')),
  'cancelled',
  'archive can be cancelled during its undo window'
);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', true);

select is(
  (select count(*) from public.mobile_commands),
  0::bigint,
  'another user cannot read command activity'
);

reset role;
insert into public.mobile_commands (
  id,
  user_id,
  client_request_id,
  device_id,
  feed_id,
  card_id,
  feed_generation,
  expected_card_digest,
  kind,
  state,
  claimed_by,
  result_work_id
) values
  (
    '10000000-0000-0000-0000-000000000004',
    '00000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000004',
    'iphone',
    'inbox',
    'card-1',
    'pass:1',
    'digest-1',
    'instruction',
    'applied',
    'worker-a',
    'work-1'
  ),
  (
    '10000000-0000-0000-0000-000000000005',
    '00000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000005',
    'iphone-2',
    'inbox',
    'card-1',
    'pass:1',
    'digest-1',
    'approve_action',
    'applied',
    'worker-a',
    'work-1'
  );

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);

select lives_ok(
  $$select public.sync_mobile_command_progress(
    '00000000-0000-0000-0000-000000000001',
    'worker-b',
    '[{"commandId":"10000000-0000-0000-0000-000000000004","workId":"work-1","workStatus":"working","updatedAt":"2026-06-13T18:00:00.000Z"}]'
  )$$,
  'a different worker cannot overwrite command progress'
);

reset role;

select is(
  (select work_status from public.mobile_commands where id = '10000000-0000-0000-0000-000000000004'),
  null,
  'command progress remains owned by the worker that claimed it'
);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);

select lives_ok(
  $$select public.sync_mobile_command_progress(
    '00000000-0000-0000-0000-000000000001',
    'worker-a',
    '[{"commandId":"10000000-0000-0000-0000-000000000004","workId":"work-1","workStatus":"working","updatedAt":"2026-06-13T18:01:00.000Z"}]'
  )$$,
  'the owning worker can update every command attached to the same work item'
);

reset role;

select results_eq(
  $$select work_status from public.mobile_commands
    where result_work_id = 'work-1'
    order by id$$,
  array['working'::text, 'working'::text],
  'collapsed duplicate approvals share subsequent work progress'
);

select * from finish();
rollback;
