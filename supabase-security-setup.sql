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
-- 15. SON ADDIM (ƏLLƏ, DİQQƏTLİ OLUN) — Bucket-i PUBLIC-dən PRIVATE-ə keçirin
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
