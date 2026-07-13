-- Add the local "dismiss" mobile command kind. A dismissal removes a card from review on Tend only
-- and performs no source connector mutation, in contrast to the existing "archive" command, which
-- approves the feed's default source cleanup. This migration is additive and backwards-compatible:
-- existing command kinds and rows are unchanged.

alter table public.mobile_commands
  drop constraint mobile_commands_kind_check;

alter table public.mobile_commands
  add constraint mobile_commands_kind_check check (kind in (
    'archive',
    'dismiss',
    'instruction',
    'approve_action',
    'approve_routine_action',
    'edit_queued_instruction',
    'return_to_review'
  ));

create or replace function public.submit_mobile_command(
  p_command jsonb
) returns setof public.mobile_commands
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_id uuid;
  v_client_request_id uuid;
  v_feed_id text;
  v_card_id text;
  v_kind text;
  v_card public.mobile_cards%rowtype;
  v_action jsonb;
  v_existing public.mobile_commands%rowtype;
  v_payload jsonb;
  v_available_at timestamptz;
begin
  if v_user_id is null then
    raise exception 'authentication required';
  end if;
  v_id := (p_command ->> 'id')::uuid;
  v_client_request_id := (p_command ->> 'clientRequestId')::uuid;
  v_feed_id := p_command ->> 'feedId';
  v_card_id := p_command ->> 'cardId';
  v_kind := p_command ->> 'kind';
  if coalesce(v_feed_id, '') = '' or coalesce(v_card_id, '') = '' then
    raise exception 'feedId and cardId are required';
  end if;

  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'actionId', p_command -> 'actionId',
    'expectedActionDigest', p_command -> 'expectedActionDigest',
    'routineActionGroupId', p_command -> 'routineActionGroupId',
    'instruction', p_command -> 'instruction',
    'edits', p_command -> 'edits',
    'targetWorkId', p_command -> 'targetWorkId',
    'expectedWorkDigest', p_command -> 'expectedWorkDigest',
    'riskConfirmation', p_command -> 'riskConfirmation'
  ));

  select * into v_existing
  from public.mobile_commands
  where user_id = v_user_id and client_request_id = v_client_request_id;
  if found then
    if v_existing.id is distinct from v_id
      or v_existing.device_id is distinct from p_command ->> 'deviceId'
      or v_existing.feed_id is distinct from v_feed_id
      or v_existing.card_id is distinct from v_card_id
      or v_existing.feed_generation is distinct from p_command ->> 'feedGeneration'
      or v_existing.kind is distinct from v_kind
      or v_existing.expected_card_digest is distinct from p_command ->> 'expectedCardDigest'
      or v_existing.payload is distinct from v_payload then
      raise exception 'clientRequestId was already used for a different command';
    end if;
    return next v_existing;
    return;
  end if;

  select * into v_card
  from public.mobile_cards
  where user_id = v_user_id and feed_id = v_feed_id and card_id = v_card_id;
  if not found then
    raise exception 'card is no longer available';
  end if;
  if v_card.feed_generation <> p_command ->> 'feedGeneration' then
    raise exception 'feed advanced to a newer pass';
  end if;
  if v_card.card_digest <> p_command ->> 'expectedCardDigest' then
    raise exception 'card changed after review';
  end if;

  if v_kind in ('archive', 'dismiss', 'approve_action', 'approve_routine_action') then
    select value into v_action
    from jsonb_array_elements(coalesce(v_card.payload -> 'actions', '[]'::jsonb))
    where value ->> 'id' = coalesce(
      p_command ->> 'actionId',
      case
        when v_kind = 'archive' then 'default-cleanup'
        when v_kind = 'dismiss' then 'dismiss-card'
        else 'approve-routine-action'
      end
    );
    if v_action is null then
      raise exception 'selected action is no longer available';
    end if;
    if v_action ->> 'digest' <> p_command ->> 'expectedActionDigest' then
      raise exception 'selected action changed after review';
    end if;
  end if;

  if v_kind = 'edit_queued_instruction' then
    if v_card.payload #>> '{activeWork,id}' <> p_command ->> 'targetWorkId'
      or v_card.payload #>> '{activeWork,digest}' <> p_command ->> 'expectedWorkDigest' then
      raise exception 'queued work changed before the edit arrived';
    end if;
  end if;

  v_available_at := case when v_kind in ('archive', 'dismiss') then now() + interval '5 seconds' else now() end;

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
    payload,
    available_at
  ) values (
    v_id,
    v_user_id,
    v_client_request_id,
    p_command ->> 'deviceId',
    v_feed_id,
    v_card_id,
    p_command ->> 'feedGeneration',
    p_command ->> 'expectedCardDigest',
    v_kind,
    v_payload,
    v_available_at
  )
  returning * into v_existing;
  return next v_existing;
end;
$$;
