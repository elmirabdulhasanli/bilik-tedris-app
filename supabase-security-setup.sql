-- ═══════════════════════════════════════════════════════════════════════
-- BTM (Bilik Tədris Mərkəzi) — Baza Quraşdırması (Faza 1 + Faza 2/3 əlavələri)
-- ───────────────────────────────────────────────────────────────────────
-- Bu skripti Supabase Dashboard → SQL Editor-da BİR DƏFƏLİK işə salın.
-- Yuxarıdan aşağı sıra ilə icra olunacaq şəkildə yazılıb (asılılıqlar var).
-- Əvvəllər bu faylı artıq işə salmısınızsa, təkrar işə salmaq təhlükəsizdir
-- (hər `create policy`-dən əvvəl `drop policy if exists` var).
--
-- Nə edir:
--   1) is_admin() / is_staff_or_admin() köməkçi funksiyaları — rekursiya
--      olmadan rol yoxlamaq üçün (RLS policy-lərin öz-özünə sorğu atıb
--      sonsuz dövrə düşməsinin qarşısını alır)
--   2) profiles / consultations / document_status cədvəlləri üçün RLS
--      (consultations-a tələbənin öz görüşünü ləğv edə bilməsi üçün delete
--      siyasəti də daxildir)
--   3) "rolunu özün admin elə" boşluğunu bağlayan trigger
--   4) Documents storage bucket-i üçün fayl-səviyyəli RLS (hər tələbə
--      yalnız öz qovluğunu yükləyə/silə bilər, admin/staff hamısını oxuya bilər)
--   5) audit_log cədvəli — admin panelindəki "🧾 Qeydiyyat" tabının məlumat mənbəyi
--   6) consultations-a status (pending/confirmed/rejected) + admin_note sütunları
--      və görüş vaxtı toqquşmasını yoxlayan is_consultation_slot_taken() funksiyası
--   7) document_templates — sənəd siyahısı və son tarixləri (admin paneldən idarə)
--   8) universities — universitet kataloqu (admin paneldən idarə)
--   9) achievements — "Nailiyyətlərimiz" bölməsi + public "Achievements" bucket-i
--
-- QEYD: ADMIN_EMAILS siyahısı index.html-dəki ilə EYNİ olmalıdır.
--       Yeni admin email əlavə etsəniz, HƏM index.html-də, HƏM burada yeniləyin.
-- ═══════════════════════════════════════════════════════════════════════


-- ─── 1. KÖMƏKÇİ FUNKSİYALAR ──────────────────────────────────────────────

create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select
    auth.email() in ('rovshen.a@gmail.com', 'abdulhasanlie@gmail.com')
    or exists (
      select 1 from public.profiles
      where email = auth.email() and role = 'admin'
    );
$$;

create or replace function public.is_staff_or_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select
    public.is_admin()
    or exists (
      select 1 from public.profiles
      where email = auth.email() and role = 'staff'
    );
$$;


-- ─── 2. PROFİLES CƏDVƏLİ ─────────────────────────────────────────────────

alter table public.profiles enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles for select
  to authenticated
  using (auth.email() = email);

drop policy if exists "profiles_select_admin_staff" on public.profiles;
create policy "profiles_select_admin_staff"
  on public.profiles for select
  to authenticated
  using (public.is_staff_or_admin());

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
  on public.profiles for insert
  to authenticated
  with check (auth.email() = email or public.is_admin());

drop policy if exists "profiles_update_own_or_staff" on public.profiles;
create policy "profiles_update_own_or_staff"
  on public.profiles for update
  to authenticated
  using (auth.email() = email or public.is_staff_or_admin())
  with check (auth.email() = email or public.is_staff_or_admin());

-- İstifadəçi öz profilini yenilədikdə belə rolunu dəyişə bilməsin,
-- yeni qeydiyyatda da özünə birbaşa admin/staff rolu verə bilməsin.
create or replace function public.prevent_role_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_OP = 'INSERT' then
    if coalesce(new.role, 'student') <> 'student' and not public.is_admin() then
      raise exception 'Yalnız admin yeni istifadəçiyə admin/staff rolu verə bilər';
    end if;
  elsif TG_OP = 'UPDATE' then
    if new.role is distinct from old.role and not public.is_admin() then
      raise exception 'Yalnız admin rol dəyişə bilər';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_prevent_role_escalation on public.profiles;
create trigger trg_prevent_role_escalation
  before insert or update on public.profiles
  for each row execute function public.prevent_role_escalation();


-- Ad və ata adı ayrı sahələr kimi soruşulur (əvvəllər tək "Ad, Soyad və Ata
-- adı" xanası idi) — ata adı öz sütununda saxlanılır.
alter table public.profiles add column if not exists father_name text;


-- ─── 3. CONSULTATIONS CƏDVƏLİ ────────────────────────────────────────────

alter table public.consultations enable row level security;

drop policy if exists "consultations_select_own" on public.consultations;
create policy "consultations_select_own"
  on public.consultations for select
  to authenticated
  using (auth.email() = profile_email);

drop policy if exists "consultations_select_admin_staff" on public.consultations;
create policy "consultations_select_admin_staff"
  on public.consultations for select
  to authenticated
  using (public.is_staff_or_admin());

drop policy if exists "consultations_insert_own" on public.consultations;
create policy "consultations_insert_own"
  on public.consultations for insert
  to authenticated
  with check (auth.email() = profile_email);

drop policy if exists "consultations_update_admin_staff" on public.consultations;
create policy "consultations_update_admin_staff"
  on public.consultations for update
  to authenticated
  using (public.is_staff_or_admin());

-- Tələbə öz görüşünü ləğv edə bilsin (Konsultasiya ekranındakı "Ləğv et" düyməsi)
drop policy if exists "consultations_delete_own" on public.consultations;
create policy "consultations_delete_own"
  on public.consultations for delete
  to authenticated
  using (auth.email() = profile_email);


-- ─── 4. DOCUMENT_STATUS CƏDVƏLİ ──────────────────────────────────────────

alter table public.document_status enable row level security;

drop policy if exists "docstatus_select_own" on public.document_status;
create policy "docstatus_select_own"
  on public.document_status for select
  to authenticated
  using (auth.email() = profile_email);

drop policy if exists "docstatus_select_admin_staff" on public.document_status;
create policy "docstatus_select_admin_staff"
  on public.document_status for select
  to authenticated
  using (public.is_staff_or_admin());

drop policy if exists "docstatus_upsert_own" on public.document_status;
create policy "docstatus_upsert_own"
  on public.document_status for insert
  to authenticated
  with check (auth.email() = profile_email);

drop policy if exists "docstatus_update_own" on public.document_status;
create policy "docstatus_update_own"
  on public.document_status for update
  to authenticated
  using (auth.email() = profile_email);

-- Əvvəllər staff/admin sənədi YALNIZ görə bilirdi, dəyişə (təsdiqləyə/rədd
-- edə) bilmirdi — bax: "docstatus_update_own" yuxarıda yalnız sənədin
-- sahibinə icazə verir. Bu, admin panelindəki təsdiq/rədd düymələrinin
-- işləməsi üçün əlavə edilib.
drop policy if exists "docstatus_update_staff" on public.document_status;
create policy "docstatus_update_staff"
  on public.document_status for update
  to authenticated
  using (public.is_staff_or_admin())
  with check (public.is_staff_or_admin());

alter table public.document_status add column if not exists rejection_note text;

drop policy if exists "docstatus_delete_own" on public.document_status;
create policy "docstatus_delete_own"
  on public.document_status for delete
  to authenticated
  using (auth.email() = profile_email);


-- ─── 5. STORAGE — "Documents" BUCKET ─────────────────────────────────────
-- Fayl yolu formatı: {istifadəçi email}/{sənəd_adı}_{timestamp}.{uzantı}
-- Ona görə (storage.foldername(name))[1] = həmin faylı yükləyənin emaili.

drop policy if exists "documents_insert_own_folder" on storage.objects;
create policy "documents_insert_own_folder"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'Documents'
    and (storage.foldername(name))[1] = auth.email()
  );

drop policy if exists "documents_select_own_or_staff" on storage.objects;
create policy "documents_select_own_or_staff"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'Documents'
    and (
      (storage.foldername(name))[1] = auth.email()
      or public.is_staff_or_admin()
    )
  );

drop policy if exists "documents_delete_own" on storage.objects;
create policy "documents_delete_own"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'Documents'
    and (storage.foldername(name))[1] = auth.email()
  );

-- index.html-dəki 15MB client-side limiti server tərəfdə də məcburi edir —
-- brauzer yoxlamasını keçən (məs. birbaşa API çağırışı ilə) yükləmələr üçün.
update storage.buckets set file_size_limit = 15728640 where id = 'Documents';


-- ─── 6. AUDIT_LOG CƏDVƏLİ (Fəaliyyət qeydi — admin panelindəki "Qeydiyyat" tabı) ──
-- Kim, nə vaxt, nə etdi — status dəyişikliyi, görüş təsdiqi, işçi əlavəsi/silinməsi/rol dəyişikliyi.

create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  actor_email text not null,
  action text not null,
  target text,
  detail text,
  created_at timestamptz not null default now()
);

alter table public.audit_log enable row level security;

drop policy if exists "audit_log_select_admin" on public.audit_log;
create policy "audit_log_select_admin"
  on public.audit_log for select
  to authenticated
  using (public.is_admin());

drop policy if exists "audit_log_insert_staff_or_admin" on public.audit_log;
create policy "audit_log_insert_staff_or_admin"
  on public.audit_log for insert
  to authenticated
  with check (public.is_staff_or_admin() and auth.email() = actor_email);


-- ─── 7. CONSULTATIONS — status/admin qeydi və vaxt toqquşması yoxlaması ──
-- Admin/işçi görüşü təsdiqləyə (`status='confirmed'`) və ya rədd edib
-- alternativ vaxt təklif edə (`status='rejected'` + `admin_note`) bilsin deyə.
-- `confirmed` boolean sütunu köhnə kod uyğunluğu üçün saxlanılır, amma
-- artıq `status` əsas mənbədir.

alter table public.consultations add column if not exists status text not null default 'pending';
alter table public.consultations add column if not exists admin_note text;

update public.consultations
  set status = 'confirmed'
  where confirmed = true and status = 'pending';

-- Bir məsləhətçinin (görüş növündən asılı olmayaraq) həmin tarix/saatda artıq
-- rədd edilməmiş görüşü olub-olmadığını yoxlayır — tələbələrin bir-birinin
-- görüş məlumatlarını görməsinə ehtiyac qalmadan (RLS-i keçərək) yoxlama aparır.
create or replace function public.is_consultation_slot_taken(p_advisor_base text, p_date text, p_time text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.consultations
    where advisor_name like (p_advisor_base || '%')
      and date::text = p_date
      and time::text = p_time
      and coalesce(status, 'pending') <> 'rejected'
  );
$$;

grant execute on function public.is_consultation_slot_taken(text, text, text) to authenticated;

-- Status nə vaxt dəyişib (təsdiq/rədd) izləmək üçün — tətbiqdəki bildiriş paneli
-- görüşləri ən son dəyişənə görə sıralayır, sadəcə bron tarixinə görə yox.
alter table public.consultations add column if not exists updated_at timestamptz not null default now();

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_consultations_updated_at on public.consultations;
create trigger trg_consultations_updated_at
  before update on public.consultations
  for each row execute function public.set_updated_at();


-- ─── 8. DOCUMENT_TEMPLATES — sənəd siyahısı bazadan idarə olunur ─────────
-- Əvvəllər 12 sənəd və onların son tarixləri index.html-ə sabit yazılmışdı
-- (məs. "Son tarix — 20 iyul") — hər il köhnəlirdi və ölkəyə görə dəyişmirdi.
-- İndi admin panelindən idarə olunur. `country` boşdursa sənəd bütün
-- tələbələrə göstərilir, doldurulubsa yalnız həmin ölkəni seçənlərə.

create table if not exists public.document_templates (
  id bigint generated always as identity primary key,
  doc_name text not null,
  country text,
  due_date date,
  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.document_templates enable row level security;

drop policy if exists "doctemplates_select_all" on public.document_templates;
create policy "doctemplates_select_all"
  on public.document_templates for select
  to authenticated
  using (true);

-- Yalnız admin dəyişə bilər — sənəd tələbləri BÜTÜN tələbələrə təsir edən
-- mərkəzi konfiqurasiyadır, staff-ın gündəlik işinin hissəsi deyil.
drop policy if exists "doctemplates_write_staff" on public.document_templates;
drop policy if exists "doctemplates_write_admin" on public.document_templates;
create policy "doctemplates_write_admin"
  on public.document_templates for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());


-- ─── 9. UNIVERSITIES — universitet kataloqu bazadan idarə olunur ─────────
-- Əvvəllər siyahı JS koduna yazılmışdı; yeni universitet əlavə etmək üçün
-- kodu dəyişmək lazım gəlirdi. İndi admin paneldən əlavə/silinə bilər.
-- Cədvəl boşdursa tətbiq avtomatik daxili (built-in) siyahıya qayıdır.

create table if not exists public.universities (
  id bigint generated always as identity primary key,
  country text not null,
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (country, name)
);

alter table public.universities enable row level security;

drop policy if exists "universities_select_all" on public.universities;
create policy "universities_select_all"
  on public.universities for select
  to authenticated
  using (true);

-- Yenidən staff+admin-ə açıldı (əvvəllər admin-only edilmişdi) — istifadəçi
-- universitet kataloqunun gündəlik idarəsinin staff-ın da işi olduğuna qərar verdi.
drop policy if exists "universities_write_staff" on public.universities;
drop policy if exists "universities_write_admin" on public.universities;
create policy "universities_write_staff"
  on public.universities for all
  to authenticated
  using (public.is_staff_or_admin())
  with check (public.is_staff_or_admin());


-- ─── 10. ACHIEVEMENTS — "Nailiyyətlərimiz" bölməsi (Haqqımızda ekranı) ───
-- Admin panelindən şəkil + qısa izah əlavə/silinən nailiyyət kartları.
-- Bucket PUBLIC saxlanılır (Documents-dən fərqli olaraq) — bunlar tələbənin
-- şəxsi sənədi deyil, mərkəzin hamıya göstərmək istədiyi reklam materialıdır.

create table if not exists public.achievements (
  id bigint generated always as identity primary key,
  image_url text not null,
  caption text not null,
  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.achievements enable row level security;

drop policy if exists "achievements_select_all" on public.achievements;
create policy "achievements_select_all"
  on public.achievements for select
  to authenticated
  using (true);

drop policy if exists "achievements_write_staff" on public.achievements;
create policy "achievements_write_staff"
  on public.achievements for all
  to authenticated
  using (public.is_staff_or_admin())
  with check (public.is_staff_or_admin());

insert into storage.buckets (id, name, public)
  values ('Achievements', 'Achievements', true)
  on conflict (id) do update set public = true;

drop policy if exists "achievements_bucket_select_all" on storage.objects;
create policy "achievements_bucket_select_all"
  on storage.objects for select
  to public
  using (bucket_id = 'Achievements');

drop policy if exists "achievements_bucket_write_staff" on storage.objects;
create policy "achievements_bucket_write_staff"
  on storage.objects for all
  to authenticated
  using (bucket_id = 'Achievements' and public.is_staff_or_admin())
  with check (bucket_id = 'Achievements' and public.is_staff_or_admin());

update storage.buckets set file_size_limit = 8388608 where id = 'Achievements';


-- ─── 11. ANNOUNCEMENTS — admin bütün tələbələrə bir dəfəyə mesaj göndərsin ──
-- Admin panelindən yazılan qısa elan bütün tələbələrin bildiriş zəngində görünür.

create table if not exists public.announcements (
  id bigint generated always as identity primary key,
  message text not null,
  created_by text,
  created_at timestamptz not null default now()
);

alter table public.announcements enable row level security;

drop policy if exists "announcements_select_all" on public.announcements;
create policy "announcements_select_all"
  on public.announcements for select
  to authenticated
  using (true);

-- Yalnız admin göndərə bilər — səhv/yersiz mesaj bütün tələbələrə gedən ən
-- həssas əməliyyatdır.
drop policy if exists "announcements_write_staff" on public.announcements;
drop policy if exists "announcements_write_admin" on public.announcements;
create policy "announcements_write_admin"
  on public.announcements for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());


-- ─── 12. TEAM_MEMBERS — "Əməkdaşlarımız" bölməsi (Haqqımızda ekranı) ─────
-- Mərkəzin müəllim/məsləhətçi heyəti — ad, vəzifə, şəkil. Staff da idarə edə bilər.

create table if not exists public.team_members (
  id bigint generated always as identity primary key,
  name text not null,
  title text,
  photo_url text,
  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.team_members enable row level security;

drop policy if exists "team_members_select_all" on public.team_members;
create policy "team_members_select_all"
  on public.team_members for select
  to authenticated
  using (true);

drop policy if exists "team_members_write_staff" on public.team_members;
create policy "team_members_write_staff"
  on public.team_members for all
  to authenticated
  using (public.is_staff_or_admin())
  with check (public.is_staff_or_admin());

insert into storage.buckets (id, name, public)
  values ('TeamPhotos', 'TeamPhotos', true)
  on conflict (id) do update set public = true;

drop policy if exists "teamphotos_bucket_select_all" on storage.objects;
create policy "teamphotos_bucket_select_all"
  on storage.objects for select
  to public
  using (bucket_id = 'TeamPhotos');

drop policy if exists "teamphotos_bucket_write_staff" on storage.objects;
create policy "teamphotos_bucket_write_staff"
  on storage.objects for all
  to authenticated
  using (bucket_id = 'TeamPhotos' and public.is_staff_or_admin())
  with check (bucket_id = 'TeamPhotos' and public.is_staff_or_admin());

update storage.buckets set file_size_limit = 8388608 where id = 'TeamPhotos';


-- ─── 13. PARTNER_UNIVERSITIES — "Əməkdaş universitetlər" siyahısı ────────
-- Mərkəzin rəsmi əməkdaşlıq etdiyi universitetlər (bax: bilik.edu.az saytındakı
-- "Universitetlərimiz" bölməsi) — ümumi universitet kataloqundan ayrı, kiçik siyahı.

create table if not exists public.partner_universities (
  id bigint generated always as identity primary key,
  name text not null,
  country text,
  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.partner_universities enable row level security;

drop policy if exists "partner_universities_select_all" on public.partner_universities;
create policy "partner_universities_select_all"
  on public.partner_universities for select
  to authenticated
  using (true);

drop policy if exists "partner_universities_write_staff" on public.partner_universities;
create policy "partner_universities_write_staff"
  on public.partner_universities for all
  to authenticated
  using (public.is_staff_or_admin())
  with check (public.is_staff_or_admin());


-- ─── 14. SERVICES — "Xidmətlərimiz" siyahısı (qiymətlə) ──────────────────
-- Əvvəllər index.html-də sabit yazılmış 7 xidmət artıq bazadan idarə olunur,
-- qiymət sahəsi ilə birlikdə. Aşağıda həmin 7 xidmət başlanğıc olaraq köçürülür
-- (təkrar icrada dublikat yaranmasın deyə cədvəl boşdursa yalnız bir dəfə).

create table if not exists public.services (
  id bigint generated always as identity primary key,
  name text not null,
  price_text text,
  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.services enable row level security;

drop policy if exists "services_select_all" on public.services;
create policy "services_select_all"
  on public.services for select
  to authenticated
  using (true);

drop policy if exists "services_write_staff" on public.services;
create policy "services_write_staff"
  on public.services for all
  to authenticated
  using (public.is_staff_or_admin())
  with check (public.is_staff_or_admin());

insert into public.services (name, price_text, sort_order)
select v.name, v.price_text, v.sort_order
from (values
  ('Abituriyent hazırlığı (DİM, buraxılış, qəbul imtahanları)', 'Sorğu üzrə', 0),
  ('YÖS və SAT imtahanlarına hazırlıq', 'Sorğu üzrə', 1),
  ('Ümumi ingilis dili üzrə kurslar', 'Sorğu üzrə', 2),
  ('Beynəlxalq sertifikasiya imtahanlarına hazırlıq (TOEFL, IELTS, GRE, GMAT)', 'Sorğu üzrə', 3),
  ('Riyaziyyat və informatika dərsləri (o cümlədən olimpiada hazırlığı)', 'Sorğu üzrə', 4),
  ('Xaricdə təhsil üzrə konsultasiya və qeydiyyat', 'Sorğu üzrə', 5),
  ('Ali riyaziyyat və fizika fənləri üzrə dərslər (tələbələr üçün)', 'Sorğu üzrə', 6)
) as v(name, price_text, sort_order)
where not exists (select 1 from public.services);


-- ═══════════════════════════════════════════════════════════════════════
-- ─── 15. NEWS_POSTS — "Xəbərlər" lenti (Haqqımızda ekranı) ───────────────
-- DİQQƏT: bu, "announcements" cədvəlindən (bax: hissə 11) fərqlidir — o, admin-in
-- bütün tələbələrə göndərdiyi ANLIQ bildirişdir (bell), bu isə hər kəsin About Us
-- ekranında gördüyü, staff+admin-in idarə etdiyi ictimai XƏBƏR LENTİDİR.

create table if not exists public.news_posts (
  id bigint generated always as identity primary key,
  title text not null,
  body text,
  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.news_posts enable row level security;

drop policy if exists "news_posts_select_all" on public.news_posts;
create policy "news_posts_select_all"
  on public.news_posts for select
  to authenticated
  using (true);

drop policy if exists "news_posts_write_staff" on public.news_posts;
create policy "news_posts_write_staff"
  on public.news_posts for all
  to authenticated
  using (public.is_staff_or_admin())
  with check (public.is_staff_or_admin());


-- ─── 16. PARENT_LINKS — valideynə göndərilən, girişsiz "yalnız-oxu" link ──
-- Admin/staff tələbə kartından link yaradır, onu valideynə göndərir. Link
-- açanda (login olmadan) yalnız `get_parent_view` funksiyası ilə seçilmiş,
-- məhdud məlumat görünür — cədvəllərin özünə birbaşa giriş YOXDUR.

create table if not exists public.parent_links (
  id bigint generated always as identity primary key,
  token text not null unique default replace(gen_random_uuid()::text, '-', ''),
  student_email text not null,
  created_by text,
  created_at timestamptz not null default now(),
  revoked boolean not null default false
);

alter table public.parent_links enable row level security;

drop policy if exists "parent_links_all_staff" on public.parent_links;
create policy "parent_links_all_staff"
  on public.parent_links for all
  to authenticated
  using (public.is_staff_or_admin())
  with check (public.is_staff_or_admin());

-- security definer: girişi olmayan (anon) ziyarətçi belə çağıra bilir, amma
-- funksiyanın özü yalnız aşağıda seçdiyimiz sahələri qaytarır.
create or replace function public.get_parent_view(p_token text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link record;
  v_profile record;
  v_docs_total int;
  v_docs_done int;
  v_consult record;
  v_trial_exams json;
begin
  select * into v_link from public.parent_links
    where token = p_token and revoked = false
    limit 1;

  if v_link is null then
    return json_build_object('error', 'invalid');
  end if;

  select name, target_countries into v_profile
    from public.profiles where email = v_link.student_email limit 1;

  select count(*) into v_docs_total
    from public.document_status where profile_email = v_link.student_email;
  select count(*) into v_docs_done
    from public.document_status
    where profile_email = v_link.student_email and status in ('done', 'approved');

  select advisor_name, date, time into v_consult
    from public.consultations
    where profile_email = v_link.student_email and coalesce(status, 'pending') = 'confirmed'
    order by date asc, time asc
    limit 1;

  select json_agg(json_build_object(
      'exam_name', te.name,
      'payment_status', reg.payment_status,
      'correct_count', reg.correct_count,
      'wrong_count', reg.wrong_count,
      'total_questions', reg.total_questions
    ) order by reg.created_at desc)
    into v_trial_exams
    from public.trial_exam_registrations reg
    join public.trial_exams te on te.id = reg.trial_exam_id
    where reg.student_email = v_link.student_email;

  return json_build_object(
    'student_name', coalesce(v_profile.name, v_link.student_email),
    'target_countries', coalesce(v_profile.target_countries, '{}'),
    'docs_total', coalesce(v_docs_total, 0),
    'docs_done', coalesce(v_docs_done, 0),
    'consult_advisor', v_consult.advisor_name,
    'consult_date', v_consult.date,
    'consult_time', v_consult.time,
    'trial_exams', coalesce(v_trial_exams, '[]'::json)
  );
end;
$$;

grant execute on function public.get_parent_view(text) to anon, authenticated;


-- ─── 17. EXAM_RESULTS — admin/staff-in əlavə etdiyi sınaq nəticələri ─────
-- Ad/email ilə axtarıb tapılan tələbəyə sınaq nəticəsi əlavə olunur, bu da
-- həmin tələbənin bildiriş zənginə avtomatik düşür (bax: index.html-də
-- fetchExamResults()).

create table if not exists public.exam_results (
  id bigint generated always as identity primary key,
  student_email text not null,
  exam_name text not null,
  result_text text not null,
  created_by text,
  created_at timestamptz not null default now()
);

alter table public.exam_results enable row level security;

drop policy if exists "exam_results_select_own_or_staff" on public.exam_results;
create policy "exam_results_select_own_or_staff"
  on public.exam_results for select
  to authenticated
  using (auth.email() = student_email or public.is_staff_or_admin());

drop policy if exists "exam_results_write_staff" on public.exam_results;
create policy "exam_results_write_staff"
  on public.exam_results for insert
  to authenticated
  with check (public.is_staff_or_admin());

drop policy if exists "exam_results_delete_staff" on public.exam_results;
create policy "exam_results_delete_staff"
  on public.exam_results for delete
  to authenticated
  using (public.is_staff_or_admin());


-- ─── 18. TRIAL_EXAMS + TRIAL_EXAM_REGISTRATIONS — ödənişli sınaq imtahanları ──
-- Admin/staff sınaq imtahanı (ad+qiymət+izah) əlavə edir, tələbə Ev ekranından
-- görüb qeydiyyatdan keçir. Ödəniş nağd/bank köçürməsi ilə OFFLINE aparılır —
-- admin panel yalnız statusu (gözlənilir/ödənilib) əl ilə qeyd etmək üçündür,
-- kart ödənişi inteqrasiyası YOXDUR.

create table if not exists public.trial_exams (
  id bigint generated always as identity primary key,
  name text not null,
  description text,
  price_text text,
  time_limit_minutes int,
  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Cədvəl əvvəlki SQL icrasında (vaxt limiti dəstəyi olmadan) yaradılmış ola bilər:
alter table public.trial_exams add column if not exists time_limit_minutes int;

alter table public.trial_exams enable row level security;

drop policy if exists "trial_exams_select_all" on public.trial_exams;
create policy "trial_exams_select_all"
  on public.trial_exams for select
  to authenticated
  using (true);

drop policy if exists "trial_exams_write_staff" on public.trial_exams;
create policy "trial_exams_write_staff"
  on public.trial_exams for all
  to authenticated
  using (public.is_staff_or_admin())
  with check (public.is_staff_or_admin());

create table if not exists public.trial_exam_registrations (
  id bigint generated always as identity primary key,
  trial_exam_id bigint not null references public.trial_exams(id) on delete cascade,
  student_email text not null,
  payment_status text not null default 'gözlənilir',
  -- Nəticə (yalnız test-tipli, doğru/səhv sualla ölçülən imtahanlar üçün) —
  -- admin qeyd edəndə faiz/bal JS tərəfində correct/total-dan hesablanır.
  correct_count int,
  wrong_count int,
  total_questions int,
  -- Tələbə sualları İLK dəfə açanda (get_trial_exam_questions) yazılır —
  -- vaxt limitinin başlanğıcı budur. Admin "yenidən cəhdə icazə ver" edəndə
  -- correct_count/wrong_count/total_questions ilə birlikdə null-a qaytarılır.
  started_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Cədvəl əvvəlki SQL icrasında (vaxt limiti dəstəyi olmadan) yaradılmış ola bilər:
alter table public.trial_exam_registrations add column if not exists started_at timestamptz;

alter table public.trial_exam_registrations enable row level security;

-- Ödəniş statusu dəyişəndə updated_at avtomatik yenilənir — bildiriş paneli
-- bunu "yeni dəyişiklik" kimi tanıyıb yenidən "görülməmiş" göstərsin deyə
-- (bax: public.set_updated_at(), consultations cədvəlində də eyni məntiq).
drop trigger if exists trg_trial_reg_updated_at on public.trial_exam_registrations;
create trigger trg_trial_reg_updated_at
  before update on public.trial_exam_registrations
  for each row execute function public.set_updated_at();

-- Tələbə öz qeydiyyatını görür, staff/admin hamısını görür
drop policy if exists "trial_reg_select_own_or_staff" on public.trial_exam_registrations;
create policy "trial_reg_select_own_or_staff"
  on public.trial_exam_registrations for select
  to authenticated
  using (auth.email() = student_email or public.is_staff_or_admin());

-- Tələbə özü qeydiyyatdan keçir (yalnız öz emaili ilə)
drop policy if exists "trial_reg_insert_own" on public.trial_exam_registrations;
create policy "trial_reg_insert_own"
  on public.trial_exam_registrations for insert
  to authenticated
  with check (auth.email() = student_email);

-- Ödəniş statusunu yalnız staff/admin dəyişə bilər
drop policy if exists "trial_reg_update_staff" on public.trial_exam_registrations;
create policy "trial_reg_update_staff"
  on public.trial_exam_registrations for update
  to authenticated
  using (public.is_staff_or_admin())
  with check (public.is_staff_or_admin());

-- Tələbə hələ ödənilməmiş öz qeydiyyatını ləğv edə bilər, staff/admin hamısını silə bilər
drop policy if exists "trial_reg_delete_own_pending_or_staff" on public.trial_exam_registrations;
create policy "trial_reg_delete_own_pending_or_staff"
  on public.trial_exam_registrations for delete
  to authenticated
  using ((auth.email() = student_email and payment_status = 'gözlənilir') or public.is_staff_or_admin());


-- ─── 19. TRIAL_EXAM_QUESTIONS — tam interaktiv sınaq sistemi ─────────────
-- Admin sualları (4 seçim + doğru cavab) daxil edir. Tələbə cədvələ birbaşa
-- ÇIXIŞI YOXDUR (RLS yalnız staff/admin-ə icazə verir) — doğru cavab heç vaxt
-- brauzerə ötürülmür. Tələbə suallara YALNIZ get_trial_exam_questions() ilə
-- baxır (correct_index qaytarmır), cavabları YALNIZ submit_trial_exam_answers()
-- ilə göndərir (yoxlama serverdə olur). Beləcə şəbəkə sorğularına baxsa belə
-- tələbə düzgün cavabı əvvəlcədən görə bilməz.

-- ─── SUAL BAZASI (question bank) — YÖS/SAT/İELTS/TOEFL/DİM kimi paylaşılan hovuzlar ──
-- Konkret sınaq imtahanından (trial_exams) AYRI, təkrar istifadə edilən sual
-- kolleksiyaları. Məs. "YÖS" bazasına 500 sual yükləyirsiniz, sonra hər ay
-- yaratdığınız yeni "YÖS Sentyabr sınağı", "YÖS Oktyabr sınağı" və s. HAMISI
-- eyni bazadan (fərqli tərkib qaydaları ilə) random sual çəkə bilər — hər
-- yeni sınaq üçün sualları YENIDƏN yükləməyə ehtiyac qalmır.
create table if not exists public.question_banks (
  id bigint generated always as identity primary key,
  name text not null unique,
  created_at timestamptz not null default now()
);

alter table public.question_banks enable row level security;

drop policy if exists "question_banks_all_staff" on public.question_banks;
create policy "question_banks_all_staff"
  on public.question_banks for all
  to authenticated
  using (public.is_staff_or_admin())
  with check (public.is_staff_or_admin());

-- Başlanğıc olaraq 5 tanınmış imtahan adı ilə boş baza yaradılır (yalnız AD —
-- kateqoriya/sual sayı kimi konkret ədədlər YAZILMIR, çünki bunlar mərkəzdən-
-- mərkəzə/universitetdən-universitetə dəyişir; sualları və kateqoriyaları
-- admin/staff özü yükləyir).
insert into public.question_banks (name)
select v.name from (values ('YÖS'), ('SAT'), ('IELTS'), ('TOEFL'), ('DİM')) as v(name)
where not exists (select 1 from public.question_banks where name = v.name);

-- Konkret sınaq imtahanı (trial_exams) istəyə bağlı bir bazaya bağlanır —
-- bağlanıbsa random seçim ORADAN, bağlanmayıbsa (əvvəlki kimi) imtahanın
-- ÖZ birbaşa yüklənmiş suallarından edilir (bax: get_trial_exam_questions()).
alter table public.trial_exams add column if not exists question_bank_id bigint references public.question_banks(id) on delete set null;

create table if not exists public.trial_exam_questions (
  id bigint generated always as identity primary key,
  -- Ya BİR konkret sınaq imtahanına (trial_exam_id), ya da paylaşılan bir
  -- bazaya (question_bank_id) aiddir — heç vaxt ikisinə birdən. Tətbiq
  -- kodu bunu təmin edir (insert zamanı yalnız biri doldurulur).
  trial_exam_id bigint references public.trial_exams(id) on delete cascade,
  question_bank_id bigint references public.question_banks(id) on delete cascade,
  question_text text not null,
  image_url text,
  -- Dinləmə tipli suallar üçün (məs. IELTS/TOEFL Listening tərzi) — istəyə bağlı.
  audio_url text,
  -- Boşdursa "ümumi hovuz" sayılır. Kateqoriya sərbəst mətndir (admin özü
  -- yazır, məs. "Riyaziyyat", "IQ", "Coğrafiya") — bax: trial_exam_question_rules.
  category text,
  options jsonb not null,
  correct_index int not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

-- Cədvəl əvvəlki SQL icrasında (şəkil/səs/kateqoriya/baza dəstəyi olmadan)
-- yaradılmış ola bilər — "create table if not exists" bu halda sütunları
-- əlavə etməz, ona görə əlavə təminat:
alter table public.trial_exam_questions add column if not exists image_url text;
alter table public.trial_exam_questions add column if not exists audio_url text;
alter table public.trial_exam_questions add column if not exists category text;
alter table public.trial_exam_questions add column if not exists question_bank_id bigint references public.question_banks(id) on delete cascade;
-- trial_exam_id əvvəllər "not null" idi — indi sual bir bazaya da aid ola
-- bilər deyə bu tələb götürülür (mövcud sətirlər təsirlənmir):
alter table public.trial_exam_questions alter column trial_exam_id drop not null;

alter table public.trial_exam_questions enable row level security;

drop policy if exists "trial_questions_all_staff" on public.trial_exam_questions;
create policy "trial_questions_all_staff"
  on public.trial_exam_questions for all
  to authenticated
  using (public.is_staff_or_admin())
  with check (public.is_staff_or_admin());

-- ─── SUAL HOVUZU — kateqoriyaya görə say qaydaları + hər tələbəyə random seçim ──
-- Admin "bu imtahanda Riyaziyyatdan 10, IQ-dan 5, Coğrafiyadan 5 sual olsun"
-- kimi qayda təyin edir (trial_exam_question_rules). Tələbə sınağı İLK dəfə
-- açanda sistem bu qaydalara görə hovuzdan RANDOM sual seçib
-- trial_exam_registration_questions-a "dondurur" — beləcə səhifəni yeniləsə
-- belə eyni suallarla qarşılaşır, amma iki tələbə adətən fərqli suallar alır.
-- Heç bir qayda yoxdursa (adi/köhnə sınaqlar) həmin imtahanın BÜTÜN sualları
-- istifadə olunur — geriyə uyğunluq üçün.

create table if not exists public.trial_exam_question_rules (
  id bigint generated always as identity primary key,
  trial_exam_id bigint not null references public.trial_exams(id) on delete cascade,
  category text not null,
  question_count int not null check (question_count > 0),
  created_at timestamptz not null default now(),
  unique (trial_exam_id, category)
);

alter table public.trial_exam_question_rules enable row level security;

drop policy if exists "trial_question_rules_all_staff" on public.trial_exam_question_rules;
create policy "trial_question_rules_all_staff"
  on public.trial_exam_question_rules for all
  to authenticated
  using (public.is_staff_or_admin())
  with check (public.is_staff_or_admin());

-- ─── ADLANDIRILMIŞ TƏRKİB ŞABLONLARI (YÖS, SAT, DİM və s.) ───────────────
-- Mərkəz öz bildiyi konkret imtahan formatını (məs. "YÖS — Bilkənt" üçün
-- Riyaziyyat/Həndəsə/IQ say bölgüsü) BİR DƏFƏ "Riyaziyyat: 30, Həndəsə: 25,
-- IQ: 25" kimi şablon olaraq saxlayır, sonra istənilən yeni sınaq imtahanı
-- yaradanda bir kliklə tətbiq edir. Qəsdən HEÇ bir konkret imtahan (YÖS/SAT/
-- IELTS/TOEFL/DİM) formatı əvvəlcədən doldurulmayıb — bu beynəlxalq
-- imtahanların dəqiq sual bölgüsü universitetdən/ilə dəyişir və köhnəlir,
-- ona görə mərkəzin özünün dəqiq bildiyi formatı yazması daha etibarlıdır.
create table if not exists public.trial_exam_rule_templates (
  id bigint generated always as identity primary key,
  name text not null unique,
  rules jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.trial_exam_rule_templates enable row level security;

drop policy if exists "trial_rule_templates_all_staff" on public.trial_exam_rule_templates;
create policy "trial_rule_templates_all_staff"
  on public.trial_exam_rule_templates for all
  to authenticated
  using (public.is_staff_or_admin())
  with check (public.is_staff_or_admin());

-- Bir qeydiyyata (cəhdə) faktiki HANSI sualların verildiyinin dondurulmuş qeydi.
create table if not exists public.trial_exam_registration_questions (
  registration_id bigint not null references public.trial_exam_registrations(id) on delete cascade,
  question_id bigint not null references public.trial_exam_questions(id) on delete cascade,
  primary key (registration_id, question_id)
);

alter table public.trial_exam_registration_questions enable row level security;

-- Tələbə YALNIZ öz cəhdinə aid sualların ID-lərini görə bilər (sualın özünü
-- yox — bu, submit_trial_exam_answers-in daxili yoxlaması üçündür).
drop policy if exists "trial_reg_questions_select_own_or_staff" on public.trial_exam_registration_questions;
create policy "trial_reg_questions_select_own_or_staff"
  on public.trial_exam_registration_questions for select
  to authenticated
  using (
    public.is_staff_or_admin()
    or exists (
      select 1 from public.trial_exam_registrations r
      where r.id = registration_id and r.student_email = auth.email()
    )
  );

drop policy if exists "trial_reg_questions_all_staff" on public.trial_exam_registration_questions;
create policy "trial_reg_questions_all_staff"
  on public.trial_exam_registration_questions for all
  to authenticated
  using (public.is_staff_or_admin())
  with check (public.is_staff_or_admin());

-- Sual şəkilləri üçün public bucket (məs. qrafik/xəritə tələb edən suallar).
insert into storage.buckets (id, name, public)
  values ('QuestionImages', 'QuestionImages', true)
  on conflict (id) do update set public = true;

drop policy if exists "questionimages_bucket_select_all" on storage.objects;
create policy "questionimages_bucket_select_all"
  on storage.objects for select
  to public
  using (bucket_id = 'QuestionImages');

drop policy if exists "questionimages_bucket_write_staff" on storage.objects;
create policy "questionimages_bucket_write_staff"
  on storage.objects for all
  to authenticated
  using (bucket_id = 'QuestionImages' and public.is_staff_or_admin())
  with check (bucket_id = 'QuestionImages' and public.is_staff_or_admin());

update storage.buckets set file_size_limit = 8388608 where id = 'QuestionImages';

-- Sual səs yazıları üçün public bucket (dinləmə tipli suallar).
insert into storage.buckets (id, name, public)
  values ('QuestionAudio', 'QuestionAudio', true)
  on conflict (id) do update set public = true;

drop policy if exists "questionaudio_bucket_select_all" on storage.objects;
create policy "questionaudio_bucket_select_all"
  on storage.objects for select
  to public
  using (bucket_id = 'QuestionAudio');

drop policy if exists "questionaudio_bucket_write_staff" on storage.objects;
create policy "questionaudio_bucket_write_staff"
  on storage.objects for all
  to authenticated
  using (bucket_id = 'QuestionAudio' and public.is_staff_or_admin())
  with check (bucket_id = 'QuestionAudio' and public.is_staff_or_admin());

update storage.buckets set file_size_limit = 20971520 where id = 'QuestionAudio';

-- Yalnız ödənişi təsdiqlənmiş, hələ imtahanı verməmiş tələbəyə sualları
-- (doğru cavab OLMADAN) qaytarır. İlk açılışda vaxt sayğacı (started_at)
-- başladılır VƏ sual dəsti "dondurulur": trial_exam_question_rules varsa
-- hər kateqoriyadan random sayda sual seçilir, yoxdursa imtahanın BÜTÜN
-- sualları istifadə olunur — hər iki halda seçim
-- trial_exam_registration_questions-a yazılır ki, səhifə yenilənəndə eyni
-- suallar qalsın və iki tələbə adətən fərqli suallar alsın. Vaxt limiti
-- keçibsə (tələbə imtahanı bağlayıb sonra qayıdıbsa) cəhd avtomatik
-- "hamısı səhv" kimi bağlanır ki, geri qayıdıb əlavə vaxt qazana bilməsin.
create or replace function public.get_trial_exam_questions(p_trial_exam_id bigint)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := auth.email();
  v_reg record;
  v_exam record;
  v_questions json;
  v_total int;
  v_started_at timestamptz;
  v_rule record;
  v_has_snapshot boolean;
begin
  -- "for update" — iki eyni vaxtda çağırış (məs. cüt-klik, iki tab) sual
  -- dəstinin İKİ DƏFƏ (fərqli random seçimlərlə) yazılmasının qarşısını alır:
  -- ikinci çağırış birincinin bitməsini gözləyir, onda artıq started_at
  -- dolu olur və random seçim təkrarlanmır.
  select * into v_reg from public.trial_exam_registrations
    where trial_exam_id = p_trial_exam_id and student_email = v_email
    order by created_at desc
    limit 1
    for update;

  if v_reg is null or v_reg.payment_status <> 'ödənilib' then
    return json_build_object('error', 'not_eligible');
  end if;
  if v_reg.total_questions is not null then
    return json_build_object('error', 'already_taken');
  end if;

  select * into v_exam from public.trial_exams where id = p_trial_exam_id;
  v_started_at := v_reg.started_at;

  if v_started_at is null then
    v_started_at := now();

    -- Sual dəstini bu cəhd üçün BİR DƏFƏLİK dondur. İmtahan bir sual bazasına
    -- (question_bank_id) bağlıdırsa hovuz ORADAN, bağlı deyilsə imtahanın ÖZ
    -- birbaşa yüklənmiş suallarından (trial_exam_id) çəkilir.
    select exists(select 1 from public.trial_exam_question_rules where trial_exam_id = p_trial_exam_id) into v_has_snapshot;
    if v_has_snapshot then
      for v_rule in select * from public.trial_exam_question_rules where trial_exam_id = p_trial_exam_id loop
        insert into public.trial_exam_registration_questions (registration_id, question_id)
        select v_reg.id, q.id from public.trial_exam_questions q
          where q.category = v_rule.category
            and (
              (v_exam.question_bank_id is not null and q.question_bank_id = v_exam.question_bank_id)
              or (v_exam.question_bank_id is null and q.trial_exam_id = p_trial_exam_id)
            )
          order by random()
          limit v_rule.question_count;
      end loop;
    else
      insert into public.trial_exam_registration_questions (registration_id, question_id)
      select v_reg.id, q.id from public.trial_exam_questions q
        where (v_exam.question_bank_id is not null and q.question_bank_id = v_exam.question_bank_id)
           or (v_exam.question_bank_id is null and q.trial_exam_id = p_trial_exam_id);
    end if;

    update public.trial_exam_registrations set started_at = v_started_at
      where id = v_reg.id;
  elsif v_exam.time_limit_minutes is not null
    and now() > v_started_at + (v_exam.time_limit_minutes || ' minutes')::interval then
    select count(*) into v_total from public.trial_exam_registration_questions where registration_id = v_reg.id;
    update public.trial_exam_registrations
      set correct_count = 0, wrong_count = v_total, total_questions = v_total
      where id = v_reg.id;
    return json_build_object('error', 'time_expired');
  end if;

  select json_agg(json_build_object('id', q.id, 'question_text', q.question_text, 'image_url', q.image_url, 'audio_url', q.audio_url, 'options', q.options) order by q.id)
    into v_questions
    from public.trial_exam_registration_questions rq
    join public.trial_exam_questions q on q.id = rq.question_id
    where rq.registration_id = v_reg.id;

  return json_build_object(
    'registration_id', v_reg.id,
    'questions', coalesce(v_questions, '[]'::json),
    'started_at', v_started_at,
    'time_limit_minutes', v_exam.time_limit_minutes
  );
end;
$$;

grant execute on function public.get_trial_exam_questions(bigint) to authenticated;

-- Tələbənin cavablarını (p_answers: [{"question_id":1,"selected_index":2}, ...])
-- serverdə doğru cavablarla müqayisə edib nəticəni hesablayır və
-- trial_exam_registrations-a yazır. Doğru cavablar heç vaxt cavab olaraq
-- qaytarılmır — yalnız yekun say (correct/wrong/total).
--
-- TƏHLÜKƏSİZLİK: hər `question_id` HƏMİN QEYDİYYATA (cəhdə) DONDURULMUŞ
-- sual dəstinə (`trial_exam_registration_questions`) aid olduğu join ilə
-- yoxlanılır və hər sual `distinct on` ilə YALNIZ BİR DƏFƏ sayılır — əks
-- halda tələbə başqa (və ya heç mövcud olmayan) sual ID-si göndərərək, ya da
-- bir sualı çox dəfə təkrarlayaraq balını süni şəkildə artıra bilərdi (məs.
-- RPC-ni birbaşa çağırıb 50 dəfə eyni asan sualı göndərmək). Random seçim
-- olan imtahanlarda bu, HƏM DƏ başqa tələbəyə verilmiş (öz dəstində olmayan)
-- sualın cavabını göndərməyin qarşısını alır. `payment_status` də yenidən
-- yoxlanılır ki, ödənişi təsdiqlənməmiş tələbə funksiyanı birbaşa çağıraraq
-- imtahanı "keçmiş" kimi işarələyə bilməsin.
create or replace function public.submit_trial_exam_answers(p_registration_id bigint, p_answers jsonb)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := auth.email();
  v_reg record;
  v_total int;
  v_correct int := 0;
  v_wrong int := 0;
begin
  select * into v_reg from public.trial_exam_registrations where id = p_registration_id for update;
  if v_reg is null or v_reg.student_email <> v_email then
    return json_build_object('error', 'not_allowed');
  end if;
  if v_reg.payment_status <> 'ödənilib' then
    return json_build_object('error', 'not_eligible');
  end if;
  if v_reg.total_questions is not null then
    return json_build_object('error', 'already_taken');
  end if;

  select count(*) into v_total from public.trial_exam_registration_questions where registration_id = p_registration_id;

  select count(*) into v_correct
  from (
    select distinct on (q.id) q.id, (a.selected_index = q.correct_index) as is_correct
    from jsonb_to_recordset(p_answers) as a(question_id bigint, selected_index int)
    join public.trial_exam_registration_questions rq
      on rq.registration_id = p_registration_id and rq.question_id = a.question_id
    join public.trial_exam_questions q on q.id = rq.question_id
    order by q.id
  ) matched
  where is_correct;

  v_wrong := v_total - v_correct;

  update public.trial_exam_registrations
    set correct_count = v_correct, wrong_count = v_wrong, total_questions = v_total
    where id = p_registration_id;

  return json_build_object('correct_count', v_correct, 'wrong_count', v_wrong, 'total_questions', v_total);
end;
$$;

grant execute on function public.submit_trial_exam_answers(bigint, jsonb) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 20. Documents bucket-i PUBLIC-dən PRIVATE-ə keçirilir
-- ───────────────────────────────────────────────────────────────────────
-- Tələbə sənədləri (pasport, sertifikat və s.) şəxsi məlumatdır. index.html
-- artıq bütün sənəd önizləmə/açma keçidlərində signed URL istifadə edir
-- (bax: getSignedDocUrl()), ona görə bu dəyişiklikdən sonra da admin panel
-- sənədləri açmağa davam edəcək — funksionallıq POZULMUR. Yalnız əvvəllər
-- paylaşılmış "public" linklər (əgər varsa) bundan sonra işləməyəcək.
-- Bucket artıq private-dirsə bu sətir sadəcə heç nə dəyişmir (təhlükəsiz).
update storage.buckets set public = false where id = 'Documents';
-- ═══════════════════════════════════════════════════════════════════════
