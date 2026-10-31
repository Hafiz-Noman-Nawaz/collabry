insert into storage.buckets (id, name, public)
values ('project-files', 'project-files', false), ('message-attachments', 'message-attachments', false)
on conflict (id) do update set public = false;

create policy project_files_storage_read on storage.objects
for select to authenticated
using (
  bucket_id = 'project-files'
  and public.is_team_member(split_part(name, '/', 1)::uuid)
);

create policy project_files_storage_insert on storage.objects
for insert to authenticated
with check (
  bucket_id = 'project-files'
  and public.is_team_member(split_part(name, '/', 1)::uuid)
  and split_part(name, '/', 2)::uuid = auth.uid()
);

create policy message_attachments_storage_read on storage.objects
for select to authenticated
using (
  bucket_id = 'message-attachments'
  and exists (
    select 1
    from public.message_attachments attachment
    join public.messages message on message.id = attachment.message_id
    join public.conversation_members member on member.conversation_id = message.conversation_id
    where attachment.storage_path = name and member.user_id = auth.uid()
  )
);

create policy message_attachments_storage_insert on storage.objects
for insert to authenticated
with check (
  bucket_id = 'message-attachments'
  and split_part(name, '/', 1)::uuid = auth.uid()
);
