create or replace function public.accept_invitation_by_token(raw_token text)
returns public.team_members language plpgsql security definer set search_path = public
as $$
declare invite public.invitations; membership public.team_members; current_email text; token_digest text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if raw_token is null or char_length(raw_token) < 20 then raise exception 'Invalid invitation token'; end if;
  token_digest := encode(digest(raw_token, 'sha256'), 'hex');
  select email into current_email from auth.users where id = auth.uid();
  select * into invite from public.invitations where token_hash = token_digest and status = 'pending' and expires_at > now() for update;
  if invite.id is null then raise exception 'Invitation is unavailable or expired'; end if;
  if invite.invitee_id is not null and invite.invitee_id <> auth.uid() then raise exception 'Invitation recipient mismatch'; end if;
  if invite.invitee_id is null and lower(invite.invitee_email) <> lower(coalesce(current_email, '')) then raise exception 'Invitation recipient mismatch'; end if;
  insert into public.team_members (team_id, user_id, role) values (invite.team_id, auth.uid(), invite.role)
  on conflict (team_id, user_id) do update set role = excluded.role returning * into membership;
  update public.invitations set status = 'accepted', invitee_id = auth.uid(), accepted_at = now() where id = invite.id;
  return membership;
end;
$$;

revoke all on function public.accept_invitation_by_token(text) from public;
grant execute on function public.accept_invitation_by_token(text) to authenticated;
