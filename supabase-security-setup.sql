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
  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

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
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

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

create table if not exists public.trial_exam_questions (
  id bigint generated always as identity primary key,
  trial_exam_id bigint not null references public.trial_exams(id) on delete cascade,
  question_text text not null,
  options jsonb not null,
  correct_index int not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

alter table public.trial_exam_questions enable row level security;

drop policy if exists "trial_questions_all_staff" on public.trial_exam_questions;
create policy "trial_questions_all_staff"
  on public.trial_exam_questions for all
  to authenticated
  using (public.is_staff_or_admin())
  with check (public.is_staff_or_admin());

-- Yalnız ödənişi təsdiqlənmiş, hələ imtahanı verməmiş tələbəyə sualları
-- (doğru cavab OLMADAN) qaytarır.
create or replace function public.get_trial_exam_questions(p_trial_exam_id bigint)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := auth.email();
  v_reg record;
  v_questions json;
begin
  select * into v_reg from public.trial_exam_registrations
    where trial_exam_id = p_trial_exam_id and student_email = v_email
    order by created_at desc
    limit 1;

  if v_reg is null or v_reg.payment_status <> 'ödənilib' then
    return json_build_object('error', 'not_eligible');
  end if;
  if v_reg.total_questions is not null then
    return json_build_object('error', 'already_taken');
  end if;

  select json_agg(json_build_object('id', id, 'question_text', question_text, 'options', options) order by sort_order, id)
    into v_questions
    from public.trial_exam_questions
    where trial_exam_id = p_trial_exam_id;

  return json_build_object('registration_id', v_reg.id, 'questions', coalesce(v_questions, '[]'::json));
end;
$$;

grant execute on function public.get_trial_exam_questions(bigint) to authenticated;

-- Tələbənin cavablarını (p_answers: [{"question_id":1,"selected_index":2}, ...])
-- serverdə doğru cavablarla müqayisə edib nəticəni hesablayır və
-- trial_exam_registrations-a yazır. Doğru cavablar heç vaxt cavab olaraq
-- qaytarılmır — yalnız yekun say (correct/wrong/total).
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
  v_answer record;
  v_correct_idx int;
begin
  select * into v_reg from public.trial_exam_registrations where id = p_registration_id;
  if v_reg is null or v_reg.student_email <> v_email then
    return json_build_object('error', 'not_allowed');
  end if;
  if v_reg.total_questions is not null then
    return json_build_object('error', 'already_taken');
  end if;

  select count(*) into v_total from public.trial_exam_questions where trial_exam_id = v_reg.trial_exam_id;

  for v_answer in select * from jsonb_to_recordset(p_answers) as x(question_id bigint, selected_index int)
  loop
    select correct_index into v_correct_idx from public.trial_exam_questions where id = v_answer.question_id;
    if v_correct_idx is not null then
      if v_correct_idx = v_answer.selected_index then
        v_correct := v_correct + 1;
      else
        v_wrong := v_wrong + 1;
      end if;
    end if;
  end loop;

  update public.trial_exam_registrations
    set correct_count = v_correct, wrong_count = v_wrong, total_questions = v_total
    where id = p_registration_id;

  return json_build_object('correct_count', v_correct, 'wrong_count', v_wrong, 'total_questions', v_total);
end;
$$;

grant execute on function public.submit_trial_exam_answers(bigint, jsonb) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 20. SON ADDIM (ƏLLƏ, DİQQƏTLİ OLUN) — Bucket-i PUBLIC-dən PRIVATE-ə keçirin
-- ───────────────────────────────────────────────────────────────────────
-- Yuxarıdakı bütün policy-lər tətbiq olunub yoxlanmadan bunu icra ETMƏYİN.
-- index.html artıq signed URL istifadə edir, ona görə bu addımdan sonra da
-- admin panel sənədləri açmağa davam edəcək. Amma əvvəllər paylaşılmış
-- "public" linklər (əgər varsa) bundan sonra işləməyəcək.
--
-- İstədiyiniz zaman, aşağıdakı sətri şərhdən çıxarıb icra edin:
--
-- update storage.buckets set public = false where id = 'Documents';
--
-- Və ya: Supabase Dashboard → Storage → Documents → "..." → Edit bucket →
-- "Public bucket" seçimini söndürün.
-- ═══════════════════════════════════════════════════════════════════════
