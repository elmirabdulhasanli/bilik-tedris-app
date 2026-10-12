# Bilik Tədris Mərkəzi — iki sayt, bir baza

Bu repoda **iki ayrı sayt** var. Hər ikisi **eyni Supabase layihəsindən** istifadə edir;
tələbələr `profiles.source` sütunu ilə ayrılır (`kurs` / `xaric`).

```
kurs-sayti/        -> biliktedris-merkezi.netlify.app
xaricde-tehsil/    -> bilik-xaricde-tehsil.netlify.app
supabase-security-setup.sql   (ortaq baza qurulumu — yayımlanmır)
```

## kurs-sayti/

Mərkəzin öz tələbələri üçün. **Telefon görünüşündə** qalır — gələcəkdə mobil
tətbiqə çevriləcək. Tam funksionallıq:

- profil formu, universitet kataloqu, sənədlər, konsultasiya
- ödənişli sınaq imtahanları (sual bazası, taymer, avtomatik qiymətləndirmə)
- **admin paneli** — hər iki saytın tələbələri buradan idarə olunur
- bildirişlər, elanlar, komanda, xəbərlər, nailiyyətlər

Admin panelindəki **Hamısı · Kurs · Xaricdə təhsil** filtri bütün siyahılara,
dashboard göstəricilərinə, analitikaya və CSV ixraclarına tətbiq olunur.

## xaricde-tehsil/

Şəhər və ya ölkə xaricindən müraciət edənlər üçün. **Masaüstü veb saytı** —
yuxarı menyu, hero bölməsi, geniş ekranda çoxsütunlu düzen.

- **qeydiyyat ekranı yoxdur** — müraciət formunun özü hesabı yaradır
- universitet kataloqu + müqayisə, sənəd yükləmə
- konsultasiya **yalnız online** (istifadəçi mərkəzə gələ bilməz)
- "Qəbullarımız" qalereyası
- sınaq imtahanları, admin paneli, komanda/xəbərlər YOXDUR

### Giriş necə işləyir

Bazadakı bütün yazma icazələri `auth.email()` üzərindədir, ona görə hesab
mütləqdir — amma istifadəçi onu görmür:

1. Form göndərilir → arxa planda `signUp` (təsadüfi şifrə ilə) → sessiya açılır
2. Profil `source: 'xaric'` damğası ilə yazılır
3. Qayıdış: şifrə yox, e-poçta gələn **birdəfəlik link** (`signInWithOtp`)

Supabase-də "Confirm email" açıqdırsa, 1-ci addımda sessiya gəlmir — o halda
istifadəçiyə "poçtunuzu yoxlayın" deyilir və yazdıqları qaralamada saxlanılır.
Axın hər iki ayarla işləyir.

## Netlify

Hər saytın öz Netlify layihəsi var, hər ikisi bu repodan yayımlanır.
**Base directory** ayarı vacibdir:

| Netlify layihəsi | Base directory | Publish |
|---|---|---|
| `biliktedris-merkezi` | `kurs-sayti` | `.` |
| `bilik-xaricde-tehsil` | `xaricde-tehsil` | `.` |

Build command hər ikisində **boşdur** — bu, build tələb etməyən statik saytdır.

Hər qovluqda `netlify.toml`, `_headers` (CSP və təhlükəsizlik başlıqları) və
`_redirects` (`.git` və SQL faylının bağlanması) var.

## Baza

`supabase-security-setup.sql` idempotentdir — neçə dəfə işə salsanız nəticə
eynidir. Yeni sütun və ya siyasət əlavə ediləndə Supabase → SQL Editor-da
**kodu yayımlamazdan əvvəl** icra olunmalıdır.

## Yerli sınaq

```bash
npx --yes http-server kurs-sayti     -p 8081 -c-1
npx --yes http-server xaricde-tehsil -p 8082 -c-1
```
