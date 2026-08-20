    /* ═══════════════════════════════════════════════════════════
       SENTRY — xəta izləmə
       ──────────────────────────────────────────────────────────
       Sayt canlıda xəta versə, sentry.io-dakı layihəyə avtomatik
       bildiriş gəlir. Tracing/session-replay bilərəkdən söndürülüb —
       tələbələrin ekranı qeyd edilmir, yalnız xəta mətni göndərilir.
    ═══════════════════════════════════════════════════════════ */
    // localhost/127.0.0.1-da (yerli test zamanı) baş verən xətalar canlı layihəyə
    // getmesin deyə — yalnız əsl saytda (Netlify) init edilir.
    const isLocalTestHost = /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);
    if (typeof Sentry !== 'undefined' && !isLocalTestHost) {
      Sentry.init({
        dsn: 'https://d77ee3c8be4d6081aa6a6d0c069e1779@o4511930865614848.ingest.us.sentry.io/4511930889338880',
        tracesSampleRate: 0,
        replaysSessionSampleRate: 0,
        replaysOnErrorSampleRate: 0
      });
    }

    /* ═══════════════════════════════════════════════════════════
       SUPABASE KONFİQURASİYASI
       ──────────────────────────────────────────────────────────
       supabase.com → layihəni aç → Settings → API
       Project URL və anon public key-i buraya yapışdır:
    ═══════════════════════════════════════════════════════════ */
    const SUPABASE_URL = 'https://qsenepccyrcudhlqntab.supabase.co';
    const SUPABASE_ANON_KEY = 'sb_publishable_To8rpdSYIudXX62AO16rWg_nTO1i4DL';

    // Şifrə bərpası kimi email-lə göndərilən linklər üçün sabit ünvan —
    // window.location.href-dən asılı deyil, harada test edilsə də düzgün yerə yönləndirir.
    const PRODUCTION_URL = 'https://biliktedrismerkezi.netlify.app/';

    const sb = (typeof window.supabase !== 'undefined' && SUPABASE_URL !== 'YOUR_SUPABASE_URL')
      ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
      : null;

    /* ── Təhlükəsizlik: HTML escape ───────────────────────────
       İstifadəçidən/bazadan gələn HƏR mətn innerHTML-ə yazılmazdan əvvəl
       bu funksiyadan keçməlidir (ad, telefon, sərbəst mətnlə universitet,
       admin qeydi və s. — hamısı istifadəçi tərəfindən idarə oluna bilər). */
    function escapeHtml(value) {
      if (value === null || value === undefined) return '';
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    /* ── Supabase DB funksiyaları ─────────────────────────── */
    async function dbSaveProfile(data) {
      if (!sb) return { data: null, error: null };
      const result = await sb.from('profiles')
        .upsert({ ...data, updated_at: new Date().toISOString() }, { onConflict: 'email' })
        .select().single();
      // Auth-dakı user_metadata.full_name da sinxron qalsın — qeydiyyatda təyin
      // olunan ilkin ad orada donub qalırdı, profil redaktəsi onu yeniləmirdi.
      if (data.name) {
        try { await sb.auth.updateUser({ data: { full_name: data.name } }); }
        catch (e) { console.warn('Auth metadata sinxronizasiyası alınmadı:', e); }
      }
      return result;
    }
    async function dbSaveDocStatus(email, docName, status, fileUrl = null) {
      if (!sb || !email) return;
      const payload = {
        profile_email: email, doc_name: docName, status,
        uploaded_at: status === 'done' ? new Date().toISOString() : null
      };
      // Yenidən yükləmə əvvəlki rədd səbəbini ləğv edir — sənəd yenidən baxılmağı gözləyir.
      if (status === 'done') payload.rejection_note = null;
      if (fileUrl) payload.file_url = fileUrl;
      await sb.from('document_status')
        .upsert(payload,
          { onConflict: 'profile_email,doc_name' });
    }

    /* ── Sənəd faylına müvəqqəti (signed) keçid ─────────────
       `document_status.file_url` sütununda ya sadəcə storage yolu
       (yeni yükləmələr), ya da köhnə public URL (əvvəlki yükləmələr)
       saxlanıla bilər — hər iki halda faktiki storage yolunu çıxarırıq. */
    function extractDocStoragePath(value) {
      if (!value) return null;
      const marker = '/Documents/';
      const idx = value.indexOf(marker);
      if (idx !== -1) return decodeURIComponent(value.slice(idx + marker.length).split('?')[0]);
      return value;
    }
    async function getSignedDocUrl(value, expiresInSeconds = 3600) {
      const path = extractDocStoragePath(value);
      if (!path || !sb) return null;
      const { data, error } = await sb.storage.from('Documents').createSignedUrl(path, expiresInSeconds);
      if (error) { console.error('Signed URL xətası:', error); return null; }
      return data.signedUrl;
    }

    async function fetchDocumentsStatus(email) {
      // Siyahı bazadakı şablonlardan qurulur — statusları tətbiq etməzdən əvvəl
      // siyahının hazır olduğuna əmin oluruq.
      if (typeof renderDocList === 'function') await renderDocList();

      if (!sb || !email) return;
      const { data } = await sb.from('document_status')
        .select('*')
        .eq('profile_email', email);

      if (!data || !data.length) return;

      // Recreate dynamically added pages
      data.forEach(record => {
         const match = record.doc_name.match(/(.*) \(səhifə (\d+)\)$/);
         if (match) {
             const baseName = match[1];
             let exists = false;
             document.querySelectorAll('#doc-list .doc-item').forEach(i => {
                if(i.querySelector('.doc-name').textContent === record.doc_name) exists = true;
             });
             if (!exists) {
                 const currentItems = Array.from(document.querySelectorAll('#doc-list .doc-item'));
                 let lastBaseItem = null;
                 currentItems.forEach(i => {
                    if (i.querySelector('.doc-name').textContent.startsWith(baseName)) lastBaseItem = i;
                 });
                 if (lastBaseItem) {
                     const newItem = lastBaseItem.cloneNode(true);
                     newItem.dataset.status = 'pending';
                     const newStamp = newItem.querySelector('.stamp');
                     if(newStamp) { newStamp.className = 'stamp pending'; newStamp.innerHTML = '&#9675;'; }
                     const newInp = newItem.querySelector('.doc-file');
                     if(newInp) { newInp.value = ''; delete newInp.dataset.bound; }
                     const newLbl = newItem.querySelector('.upload-btn');
                     if(newLbl) { newLbl.style.display = ''; }
                     const newDelBtn = newItem.querySelector('.doc-del-btn');
                     if(newDelBtn) newDelBtn.remove();
                     const addBtn = newItem.querySelector('.add-page-btn');
                     if(addBtn) addBtn.remove();
                     
                     newItem.querySelector('.doc-name').textContent = record.doc_name;
                     lastBaseItem.parentNode.insertBefore(newItem, lastBaseItem.nextSibling);
                     if (typeof bindDocItem === 'function') bindDocItem(newItem);
                 }
             }
         }
      });

      const items = document.querySelectorAll('#doc-list .doc-item');
      items.forEach(item => {
        const docName = item.querySelector('.doc-name').textContent;
        const record = data.find(r => r.doc_name === docName);
        if (!record) return;

        const stamp = item.querySelector('.stamp');
        const dueEl = item.querySelector('.doc-due');
        const lbl = item.querySelector('.upload-btn');
        if (!dueEl.dataset.default) dueEl.dataset.default = dueEl.textContent;

        // Köhnə "Səhv faylı sil" düyməsi hər ehtimala qarşı təmizlənir —
        // rədd edilmiş sənəddə artıq bunun əvəzinə birbaşa "Yenidən yüklə" var.
        const oldDelBtn = item.querySelector('.doc-del-btn');
        if (oldDelBtn) oldDelBtn.remove();
        const oldRejectNote = item.querySelector('.doc-reject-note');
        if (oldRejectNote) oldRejectNote.remove();

        if (record.status === 'done' || record.status === 'approved') {
          item.dataset.status = 'done';
          stamp.className = 'stamp done';
          stamp.innerHTML = '&#10003;';
          dueEl.style.color = '';
          dueEl.textContent = record.status === 'approved' ? t('doc_approved', '✓ Təsdiqləndi') : t('doc_uploaded', 'Yükləndi');
          if (lbl) lbl.style.display = 'none';

          const delBtn = document.createElement('button');
          delBtn.className = 'doc-del-btn pill-btn danger';
          delBtn.textContent = t('doc_delete_wrong', 'Səhv faylı sil');
          delBtn.style.cssText = 'margin-top:6px;';
          delBtn.onclick = async () => {
            item.dataset.status = 'pending';
            stamp.className = 'stamp pending';
            stamp.innerHTML = '&#9675;';
            dueEl.textContent = dueEl.dataset.default;
            if (lbl) {
              lbl.style.display = '';
              const lblText = lbl.querySelector('.upload-btn-label');
              if (lblText) lblText.textContent = t('upload', 'Yüklə');
            }
            delBtn.remove();
            const inp = item.querySelector('.doc-file');
            if (inp) inp.value = '';
            updateDocProgress();
            await dbSaveDocStatus(currentEmail, docName, 'pending', null);
            toast('Fayl silindi. Yenisini yükləyə bilərsiniz.');
          };
          item.querySelector('div[style="flex:1;"]').appendChild(delBtn);
        } else if (record.status === 'rejected') {
          item.dataset.status = 'rejected';
          stamp.className = 'stamp rejected';
          stamp.innerHTML = '&#10007;';
          dueEl.style.color = 'var(--coral)';
          dueEl.textContent = t('doc_rejected', '❌ Rədd edildi — yenidən yüklə');
          // Yükləmə düyməsi gizlədilmir — tələbə birbaşa, əlavə addımsız yenidən yükləyə bilsin.
          if (lbl) {
            lbl.style.display = '';
            const lblText = lbl.querySelector('.upload-btn-label');
            if (lblText) lblText.textContent = t('doc_reupload', 'Yenidən yüklə');
          }

          if (record.rejection_note) {
            const note = document.createElement('p');
            note.className = 'doc-reject-note';
            note.style.cssText = 'font-size:11.5px; color:var(--coral); margin:4px 0 0; line-height:1.5;';
            note.innerHTML = `<b>${escapeHtml(t('doc_reason', 'Səbəb'))}:</b> ${escapeHtml(record.rejection_note)}`;
            item.querySelector('div[style="flex:1;"]').appendChild(note);
          }
        }
      });
      updateDocProgress();
    }
    async function dbSaveConsultation(email, advisor, date, time) {
      if (!sb || !email) return { error: null };
      return await sb.from('consultations')
        .insert({ profile_email: email, advisor_name: advisor, date, time });
    }
    // Həmin məsləhətçinin (növündən asılı olmayaraq) o tarix/saatda artıq
    // rədd edilməmiş görüşü varmı — server tərəfli funksiya vasitəsilə yoxlanılır
    // ki, tələbələr bir-birinin görüş məlumatlarını RLS-dən keçərək görə bilməsin.
    async function isSlotTaken(advisorBase, date, time) {
      if (!sb) return false;
      const { data, error } = await sb.rpc('is_consultation_slot_taken', {
        p_advisor_base: advisorBase, p_date: date, p_time: time
      });
      if (error) { console.error('Slot yoxlama xətası:', error); return false; }
      return !!data;
    }
    async function fetchConsultation(email) {
      if (!sb || !email) return;
      const { data } = await sb.from('consultations')
        .select('*')
        .eq('profile_email', email)
        .order('created_at', { ascending: false })
        .limit(5);

      const row = document.getElementById('profile-consultation-row');
      const textEl = document.getElementById('profile-consultation');
      if (row && textEl) {
        if (data && data.length > 0) {
          // Ən son yaradılan rədd edilməmiş görüşü göstər, hamısı rədd edilibsə ən sonuncunu göstər
          const c = data.find(x => (x.status || (x.confirmed ? 'confirmed' : 'pending')) !== 'rejected') || data[0];
          const meta = apptStatusMeta(c);
          textEl.textContent = `${c.advisor_name} — ${c.date} ${c.time} (${meta.label})`;
          row.style.display = 'flex';
        } else {
          row.style.display = 'none';
        }
      }
    }

    /* ═══════════════════════════════════════════════════════════
       BİLDİRİŞLƏR (görüş təsdiq/rədd hadisələri)
       ──────────────────────────────────────────────────────────
       Push infrastrukturu (backend/3-cü tərəf xidməti) olmadığı üçün
       "real" bildiriş əvəzinə — tətbiqi açanda görünən bir bildiriş
       zəngi/paneli. "Görülüb" vəziyyəti cihazda (localStorage) saxlanılır.
    ═══════════════════════════════════════════════════════════ */
    function notifSeenKey() {
      return `btm_seen_notifs_${currentEmail || ''}`;
    }
    function getSeenNotifIds() {
      try { return JSON.parse(localStorage.getItem(notifSeenKey()) || '[]'); }
      catch (e) { return []; }
    }
    function markNotifsSeen(keys) {
      try {
        const seen = new Set(getSeenNotifIds());
        keys.forEach(k => seen.add(k));
        localStorage.setItem(notifSeenKey(), JSON.stringify([...seen]));
      } catch (e) { /* localStorage yoxdursa səssizcə keç */ }
    }
    // Status təkrar dəyişərsə (məs. yenidən rədd edilərsə) yeni "görülməmiş" sayılsın deyə tərkib açar
    function notifKey(c) {
      return `${c.id}:${c.status}:${c.updated_at || ''}`;
    }

    let notifCache = [];
    // status/admin_note/updated_at sütunları supabase-security-setup.sql icra olunana qədər
    // yoxdursa, hər ekran keçidində təkrar-təkrar şəbəkə xətası yaratmamaq üçün bir dəfə
    // yoxlanılır və nəticə seansda yadda saxlanılır.
    let notifSchemaOk = true;
    async function fetchNotifications() {
      if (!sb || !currentEmail || !notifSchemaOk) return [];
      const { data, error } = await sb.from('consultations')
        .select('*')
        .eq('profile_email', currentEmail)
        .in('status', ['confirmed', 'rejected'])
        .order('updated_at', { ascending: false })
        .limit(20);
      if (error) {
        notifSchemaOk = false;
        console.warn('Bildirişlər üçün lazımi sütunlar (status/admin_note/updated_at) tapılmadı — supabase-security-setup.sql faylını yenidən icra edin:', error.message);
        return [];
      }
      return data || [];
    }
    let notifSchemaHasUpdatedAt = true;

    // Görüşü 24 saatdan az qalmış (və hələ keçməmiş) təsdiqlənmiş konsultasiya
    // üçün müştəri tərəfdə hazırlanan xatırlatma — DB-də ayrıca sətir tələb etmir.
    function getUpcomingConsultReminder() {
      if (!lastMyConsultations || !lastMyConsultations.length) return null;
      const now = new Date();
      const upcoming = lastMyConsultations
        .filter(c => apptStatusMeta(c).status === 'confirmed')
        .map(c => ({ c, dt: new Date(c.date + 'T' + c.time) }))
        .filter(x => !isNaN(x.dt) && x.dt > now && (x.dt - now) <= 24 * 60 * 60 * 1000)
        .sort((a, b) => a.dt - b.dt)[0];
      if (!upcoming) return null;
      const hoursLeft = Math.max(1, Math.round((upcoming.dt - now) / 3600000));
      // Açar günlük "bucket"-ə görə qurulur ki, xatırlatma hər gün bir dəfə
      // "görülməmiş" sayılsın, saat dəyişdikcə yenidən görülmüş sayılmasın.
      return {
        id: `reminder-${upcoming.c.id}`,
        status: 'reminder',
        advisor_name: upcoming.c.advisor_name,
        date: upcoming.c.date,
        time: upcoming.c.time,
        updated_at: now.toISOString().slice(0, 10),
        hoursLeft
      };
    }

    let announcementsSchemaOk = true;
    async function fetchAnnouncements() {
      if (!sb || !announcementsSchemaOk) return [];
      const { data, error } = await sb.from('announcements')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(10);
      if (error) {
        announcementsSchemaOk = false;
        console.warn('Elanlar cədvəli tapılmadı — supabase-security-setup.sql faylını yenidən icra edin:', error.message);
        return [];
      }
      return (data || []).map(a => ({
        id: `announce-${a.id}`,
        status: 'announcement',
        message: a.message,
        updated_at: a.created_at
      }));
    }

    let examResultsSchemaOk = true;
    async function fetchExamResults() {
      if (!sb || !currentEmail || !examResultsSchemaOk) return [];
      const { data, error } = await sb.from('exam_results')
        .select('*')
        .eq('student_email', currentEmail)
        .order('created_at', { ascending: false })
        .limit(10);
      if (error) {
        examResultsSchemaOk = false;
        console.warn('Sınaq nəticələri cədvəli tapılmadı — supabase-security-setup.sql faylını yenidən icra edin:', error.message);
        return [];
      }
      return (data || []).map(r => ({
        id: `examresult-${r.id}`,
        status: 'exam_result',
        exam_name: r.exam_name,
        result_text: r.result_text,
        updated_at: r.created_at
      }));
    }

    let trialExamRegSchemaOk = true;
    async function fetchTrialExamNotifications() {
      if (!sb || !currentEmail || !trialExamRegSchemaOk) return [];
      const { data, error } = await sb.from('trial_exam_registrations')
        .select('*, trial_exams(name)')
        .eq('student_email', currentEmail)
        .order('updated_at', { ascending: false })
        .limit(10);
      if (error) {
        trialExamRegSchemaOk = false;
        console.warn('Sınaq imtahanı qeydiyyatları cədvəli tapılmadı — supabase-security-setup.sql faylını yenidən icra edin:', error.message);
        return [];
      }
      return (data || []).map(r => ({
        id: `trialexamreg-${r.id}`,
        status: 'trialexam_reg',
        exam_name: (r.trial_exams && r.trial_exams.name) || '—',
        payment_status: r.payment_status,
        correct_count: r.correct_count,
        wrong_count: r.wrong_count,
        total_questions: r.total_questions,
        updated_at: r.updated_at
      }));
    }

    async function buildNotifCache() {
      const [list, announcements, examResults, trialExamRegs] = await Promise.all([fetchNotifications(), fetchAnnouncements(), fetchExamResults(), fetchTrialExamNotifications()]);
      const reminder = getUpcomingConsultReminder();
      const merged = reminder ? [reminder, ...list] : list;
      return [...announcements, ...examResults, ...trialExamRegs, ...merged];
    }

    async function refreshNotifBadge() {
      const badge = document.getElementById('notif-badge');
      if (!badge || !currentEmail) return;
      notifCache = await buildNotifCache();
      const seen = new Set(getSeenNotifIds());
      const unread = notifCache.filter(c => !seen.has(notifKey(c)));
      if (unread.length) {
        badge.textContent = unread.length > 9 ? '9+' : String(unread.length);
        badge.style.display = 'flex';
      } else {
        badge.style.display = 'none';
      }
    }

    async function openNotifPanel() {
      const listEl = document.getElementById('notif-list');
      if (!notifCache.length) notifCache = await buildNotifCache();

      if (!notifCache.length) {
        listEl.innerHTML = '<div class="admin-empty"><span class="empty-icon">🔔</span>Hələ bildiriş yoxdur.</div>';
      } else {
        listEl.innerHTML = notifCache.map(c => {
          if (c.status === 'announcement') {
            const when = c.updated_at ? new Date(c.updated_at).toLocaleDateString('az-AZ') : '';
            return `
            <div class="admin-card-row" style="align-items:flex-start; gap:10px;">
              <span style="font-size:18px; flex-shrink:0; margin-top:1px;">📢</span>
              <div class="admin-card-row-info">
                <p class="admin-row-name">${escapeHtml(t('notif_announcement_title', 'Mərkəzdən elan'))}</p>
                <p class="admin-row-sub">${escapeHtml(c.message)}</p>
                <p style="font-size:11px; color:var(--ink-soft); margin:3px 0 0;">${when}</p>
              </div>
            </div>`;
          }
          if (c.status === 'reminder') {
            return `
            <div class="admin-card-row" style="align-items:flex-start; gap:10px;">
              <span style="font-size:18px; flex-shrink:0; margin-top:1px;">⏰</span>
              <div class="admin-card-row-info">
                <p class="admin-row-name">${escapeHtml(t('notif_reminder_title', 'Yaxınlaşan görüş'))}</p>
                <p class="admin-row-sub">${escapeHtml(c.advisor_name)} · ${escapeHtml(c.date)} saat ${escapeHtml(c.time)} · ${escapeHtml(t('notif_reminder_hours_tpl', '{hours} saat qalıb').replace('{hours}', c.hoursLeft))}</p>
              </div>
            </div>`;
          }
          if (c.status === 'exam_result') {
            const when = c.updated_at ? new Date(c.updated_at).toLocaleDateString('az-AZ') : '';
            return `
            <div class="admin-card-row" style="align-items:flex-start; gap:10px;">
              <span style="font-size:18px; flex-shrink:0; margin-top:1px;">📊</span>
              <div class="admin-card-row-info">
                <p class="admin-row-name">${escapeHtml(t('notif_exam_title', 'Sınaq nəticəniz əlavə edildi'))}</p>
                <p class="admin-row-sub">${escapeHtml(c.exam_name)} — ${escapeHtml(c.result_text)}</p>
                <p style="font-size:11px; color:var(--ink-soft); margin:3px 0 0;">${when}</p>
              </div>
            </div>`;
          }
          if (c.status === 'trialexam_reg') {
            const when = c.updated_at ? new Date(c.updated_at).toLocaleDateString('az-AZ') : '';
            const isPaid = c.payment_status === 'ödənilib';
            const hasResult = c.total_questions !== null && c.total_questions !== undefined;
            const title = hasResult
              ? t('notif_trialexam_result_title', 'Sınaq nəticəniz hazırdır')
              : (isPaid
                ? t('notif_trialexam_paid_title', 'Sınaq ödənişiniz təsdiqləndi')
                : t('notif_trialexam_pending_title', 'Sınaq qeydiyyatınız qəbul edildi'));
            const resultLine = hasResult ? trialExamResultLine(c) : '';
            return `
            <div class="admin-card-row" style="align-items:flex-start; gap:10px;">
              <span style="font-size:18px; flex-shrink:0; margin-top:1px;">🎯</span>
              <div class="admin-card-row-info">
                <p class="admin-row-name">${escapeHtml(title)}</p>
                <p class="admin-row-sub">${escapeHtml(c.exam_name)}</p>
                ${resultLine ? `<p class="admin-row-sub" style="color:var(--teal); font-weight:600;">${escapeHtml(resultLine)}</p>` : ''}
                <p style="font-size:11px; color:var(--ink-soft); margin:3px 0 0;">${when}</p>
              </div>
            </div>`;
          }
          const isConfirmed = c.status === 'confirmed';
          const when = c.updated_at ? new Date(c.updated_at).toLocaleDateString('az-AZ') : '';
          const confirmedSentence = t('notif_confirmed_tpl', '{date} tarixində saat {time}-da {advisor} ilə görüşəcəksiniz')
            .replace('{date}', c.date).replace('{time}', c.time).replace('{advisor}', c.advisor_name);
          return `
          <div class="admin-card-row" style="align-items:flex-start; gap:10px;">
            <span style="font-size:18px; flex-shrink:0; margin-top:1px;">${isConfirmed ? '✅' : '❗'}</span>
            <div class="admin-card-row-info">
              <p class="admin-row-name">${isConfirmed ? escapeHtml(t('notif_confirmed_title', 'Görüşünüz təsdiqləndi')) : 'Görüş rədd edildi'}</p>
              ${isConfirmed
              ? `<p class="admin-row-sub">${escapeHtml(confirmedSentence)}</p>`
              : `<p class="admin-row-sub">${escapeHtml(c.advisor_name)} · ${escapeHtml(c.date)} saat ${escapeHtml(c.time)} · ${when}</p>`
            }
              ${!isConfirmed && c.admin_note ? `<p style="font-size:12px; color:var(--ink-soft); margin:5px 0 0; line-height:1.5;"><b style="color:var(--coral);">Təklif:</b> ${escapeHtml(c.admin_note)}</p>` : ''}
            </div>
          </div>`;
        }).join('');
      }

      markNotifsSeen(notifCache.map(notifKey));
      document.getElementById('notif-badge').style.display = 'none';
      openModal('notif-modal');
    }

    document.getElementById('notif-bell-btn')?.addEventListener('click', openNotifPanel);
    document.getElementById('notif-close-btn')?.addEventListener('click', () => closeModal('notif-modal'));
    document.getElementById('notif-modal')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeModal('notif-modal');
    });

    // Ev ekranındakı "Əməkdaşlar / Xidmətlər / Nailiyyətlər" kartları — basanda
    // müvafiq məlumat modalda açılır (bax: haqqımızda ekranından bura köçürülüb).
    [
      ['home-card-partner-unis', 'partner-unis-modal', loadPartnerUniversities],
      ['home-card-services', 'services-modal', loadServices],
      ['home-card-achievements', 'achievements-modal', loadAchievements],
      ['home-card-team', 'team-modal', loadTeamMembers],
      ['home-card-news', 'news-modal', loadNews],
      ['home-card-trialexams', 'trialexams-modal', loadTrialExams]
    ].forEach(([cardId, modalId, loadFn]) => {
      document.getElementById(cardId)?.addEventListener('click', () => {
        openModal(modalId);
        loadFn();
      });
      document.getElementById(modalId + '-close')?.addEventListener('click', () => closeModal(modalId));
      document.getElementById(modalId)?.addEventListener('click', (e) => {
        if (e.target === e.currentTarget) closeModal(modalId);
      });
    });

    // Tələbənin öz görüşlərinin tam siyahısı (Konsultasiya ekranı) + ləğv etmə
    async function loadMyConsultations() {
      const section = document.getElementById('my-consultations-section');
      const listEl = document.getElementById('my-consultations-list');
      if (!section || !listEl) return;

      if (!sb || !currentEmail) { section.style.display = 'none'; return; }

      const { data, error } = await sb.from('consultations')
        .select('*')
        .eq('profile_email', currentEmail)
        .order('date', { ascending: true });

      // "Növbəti addım" kartı tələbənin görüşü olub-olmadığını bilməlidir
      lastMyConsultations = (error || !data) ? [] : data;
      updateNextStepCard();

      if (error || !data || !data.length) { section.style.display = 'none'; return; }

      // Bu ekranda status onsuz da göründüyü üçün müvafiq bildirişləri "görülüb" işarələ
      markNotifsSeen(data.filter(c => c.status === 'confirmed' || c.status === 'rejected').map(notifKey));
      refreshNotifBadge();

      section.style.display = 'block';
      listEl.innerHTML = data.map(c => {
        const meta = apptStatusMeta(c);
        return `
        <div class="card" style="padding:12px 14px; margin-bottom:8px;">
          <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:10px;">
            <p class="uni-name" style="margin:0; font-size:13.5px;">${escapeHtml(c.advisor_name) || '—'}</p>
            <span class="status-badge ${meta.cls}" style="flex-shrink:0;">${meta.label}</span>
          </div>
          <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:5px;">
            <p class="uni-loc" style="margin:0;">${escapeHtml(c.date) || '—'} · saat ${escapeHtml(c.time) || '—'}</p>
            ${meta.status !== 'rejected' ? `<button class="pill-btn danger cancel-consult-btn" data-id="${c.id}">${escapeHtml(t('cancel_meeting', 'Ləğv et'))}</button>` : ''}
          </div>
          ${meta.status === 'rejected' && c.admin_note ? `<div style="margin-top:10px; padding-top:10px; border-top:1px dashed var(--line); font-size:12px; color:var(--ink-soft); line-height:1.5;"><b style="color:var(--coral);">Təklif:</b> ${escapeHtml(c.admin_note)}</div>` : ''}
        </div>`;
      }).join('');

      listEl.querySelectorAll('.cancel-consult-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Bu görüşü ləğv etmək istədiyinizə əminsiniz?')) return;
          btn.textContent = '...';
          await sb.from('consultations').delete().eq('id', btn.dataset.id).eq('profile_email', currentEmail);
          toast('Görüş ləğv edildi');
          loadMyConsultations();
          fetchConsultation(currentEmail);
        });
      });
    }

    // Bütün məsləhətçilər hər tələbəyə (ölkə seçimindən asılı olmayaraq) göstərilir.
    function updateConsultantsDisplay() {
      const farid = document.getElementById('consultant-farid');
      const ahmet = document.getElementById('consultant-ahmet');
      if (farid) farid.style.display = 'block';
      if (ahmet) ahmet.style.display = 'block';
    }

    /* ═══════════════════════════════════════════════════════════
       SESSION
    ═══════════════════════════════════════════════════════════ */
    let currentEmail = null;

    /* ═══════════════════════════════════════════════════════════
       NAVİQASİYA
    ═══════════════════════════════════════════════════════════ */
    const navBtns = document.querySelectorAll('.navbtn');
    const screens = document.querySelectorAll('.screen');

    navBtns.forEach(btn => btn.addEventListener('click', () => {
      navBtns.forEach(b => b.classList.remove('active'));
      screens.forEach(s => s.classList.remove('active'));
      btn.classList.add('active');
      const s = document.getElementById(btn.dataset.target);
      s.classList.add('active');
      s.scrollTop = 0;
      if (btn.dataset.target === 'profile') fetchConsultation(currentEmail);
      if (btn.dataset.target === 'consult') { updateConsultantsDisplay(); loadMyConsultations(); }
      if (btn.dataset.target === 'unis' && typeof renderUniCatalog === 'function') renderUniCatalog();
      if (btn.dataset.target === 'docs') fetchDocumentsStatus(currentEmail);
      if (btn.dataset.target === 'home') refreshNotifBadge();
      if (btn.dataset.target === 'onboarding' && typeof restoreOnboardingDraft === 'function') restoreOnboardingDraft();
      if (typeof updateAdminReturnFab === 'function') updateAdminReturnFab();
    }));

    function showScreen(id) {
      screens.forEach(s => s.classList.remove('active'));
      const s = document.getElementById(id);
      s.classList.add('active');
      s.scrollTop = 0;
      // Admin/işçi tələbə ekranlarına keçəndə "Panelə qayıt" zolağı həmişə görünsün.
      // Burada mərkəzləşdirilib ki, hansı yolla ekran dəyişməsindən asılı olmayaraq işləsin.
      if (typeof updateAdminReturnFab === 'function') updateAdminReturnFab();
    }

    /* ═══════════════════════════════════════════════════════════
       TOAST
    ═══════════════════════════════════════════════════════════ */
    function toast(msg, err = false) {
      const el = document.getElementById('toast');
      el.textContent = msg;
      el.style.background = err ? 'var(--coral)' : 'var(--navy)';
      el.classList.add('show');
      setTimeout(() => el.classList.remove('show'), 3200);
    }

    /* ═══════════════════════════════════════════════════════════
       AUTH & SPLASH
    ═══════════════════════════════════════════════════════════ */
    // Ad göstərmək üçün ən etibarlı mənbəni tap: əvvəlcə auth metadata,
    // tapılmasa (məs. hesab birbaşa Supabase panelindən yaradılıbsa) profiles
    // cədvəlindəki adı yoxla, o da yoxdursa ümumi "Tələbə" göstər.
    async function resolveDisplayName(email, metadataName) {
      // Bazadakı profiles.name əsas mənbədir — istifadəçi profilini redaktə
      // edəndə dəyişən elə budur. Auth metadatası yalnız hələ profili
      // olmayan (ilk dəfə formu doldurmamış) istifadəçilər üçün ehtiyatdır.
      if (sb && email) {
        const { data } = await sb.from('profiles').select('name').eq('email', email).limit(1);
        if (data && data.length && data[0].name) return data[0].name;
      }
      if (metadataName && metadataName.trim()) return metadataName.trim();
      return 'Tələbə';
    }
    document.getElementById('splash-start').addEventListener('click', async () => {
      const btn = document.getElementById('splash-start');
      btn.innerHTML = '<span class="spinner"></span>Yüklənir...';
      btn.disabled = true;

      if (!sb) {
        document.getElementById('navbar').style.display = 'flex';
        showScreen('home');
        btn.innerHTML = 'Başla';
        btn.disabled = false;
        return;
      }

      const { data: { session } } = await sb.auth.getSession();

      btn.innerHTML = 'Başla';
      btn.disabled = false;

      if (session) {
        currentEmail = session.user.email;
        const name = await resolveDisplayName(currentEmail, session.user.user_metadata?.full_name);
        document.getElementById('home-greeting').textContent = 'Salam, ' + name.split(' ')[0];
        document.getElementById('profile-name-display').textContent = name;
        document.getElementById('profile-avatar-initials').textContent = name.charAt(0).toUpperCase();
        document.getElementById('profile-email-display').textContent = currentEmail;
        
        // Auto-fill form fields
        document.getElementById('f-name').value = name;
        document.getElementById('f-email').value = currentEmail;

        // Admin/Staff rol yoxlaması
        const role = await checkUserRole(currentEmail);
        if (role === 'admin' || role === 'staff') {
          await enterAdminPanel(role);
        } else {
          document.getElementById('navbar').style.display = 'flex';
          fetchDocumentsStatus(currentEmail);
          if (typeof restoreProfile === 'function') await restoreProfile(currentEmail);
          if (typeof loadMyConsultations === 'function') loadMyConsultations(); else refreshNotifBadge();
          showScreen('home');
        }
      } else {
        document.getElementById('navbar').style.display = 'none';
        showScreen('login');
      }
    });

    // Auth Ekran keçidləri
    document.getElementById('go-register').addEventListener('click', () => showScreen('register'));
    document.getElementById('go-login').addEventListener('click', () => showScreen('login'));

    // Qeydiyyat
    document.getElementById('reg-btn').addEventListener('click', async () => {
      const name = document.getElementById('reg-name').value.trim();
      const email = document.getElementById('reg-email').value.trim();
      const password = document.getElementById('reg-password').value;
      const errEl = document.getElementById('reg-error');

      if (!name || !email || !password) { errEl.textContent = 'Bütün sahələri doldurun!'; errEl.style.display = 'block'; return; }
      if (password.length < 6) { errEl.textContent = 'Şifrə ən azı 6 simvol olmalıdır!'; errEl.style.display = 'block'; return; }

      errEl.style.display = 'none';
      const btn = document.getElementById('reg-btn');
      btn.innerHTML = '<span class="spinner"></span>Gözləyin...';
      btn.disabled = true;

      const { data, error } = await sb.auth.signUp({ email, password, options: { data: { full_name: name } } });

      btn.innerHTML = 'Qeydiyyatdan keç';
      btn.disabled = false;

      if (error) {
        errEl.textContent = error.message;
        errEl.style.display = 'block';
      } else {
        toast('Hesab uğurla yaradıldı!');
        currentEmail = email;
        document.getElementById('home-greeting').textContent = 'Salam, ' + name.split(' ')[0];
        document.getElementById('profile-name-display').textContent = name;
        document.getElementById('profile-avatar-initials').textContent = name.charAt(0).toUpperCase();
        document.getElementById('profile-email-display').textContent = currentEmail;
        
        // Auto-fill form fields
        document.getElementById('f-name').value = name;
        document.getElementById('f-email').value = currentEmail;

        // Admin/Staff rol yoxlaması
        const role = await checkUserRole(currentEmail);
        if (role === 'admin' || role === 'staff') {
          await enterAdminPanel(role);
        } else {
          document.getElementById('navbar').style.display = 'flex';
          showScreen('home');
        }
      }
    });

    /* Uğursuz giriş cəhdlərinin sayğacı (brute-force qarşısı).
       Server tərəfli deyil — sadəcə bu brauzerdə həmin email üçün UI-ni
       müvəqqəti kilidləyir. Supabase-in öz auth endpoint-ləri onsuz da
       server tərəfdən sürət məhdudiyyəti tətbiq edir; bu, əlavə bir qatdır. */
    const LOGIN_MAX_ATTEMPTS = 5;
    const LOGIN_LOCKOUT_MS = 2 * 60 * 1000;
    function loginAttemptKey(email) { return `btm_login_fail_${email.toLowerCase().trim()}`; }
    function getLoginAttemptState(email) {
      try { return JSON.parse(localStorage.getItem(loginAttemptKey(email)) || 'null') || { count: 0, lockUntil: 0 }; }
      catch (e) { return { count: 0, lockUntil: 0 }; }
    }
    function recordFailedLogin(email) {
      const state = getLoginAttemptState(email);
      state.count += 1;
      if (state.count >= LOGIN_MAX_ATTEMPTS) {
        state.lockUntil = Date.now() + LOGIN_LOCKOUT_MS;
        state.count = 0;
      }
      try { localStorage.setItem(loginAttemptKey(email), JSON.stringify(state)); } catch (e) { }
    }
    function clearLoginAttempts(email) {
      try { localStorage.removeItem(loginAttemptKey(email)); } catch (e) { }
    }

    // Giriş
    document.getElementById('login-btn').addEventListener('click', async () => {
      const email = document.getElementById('login-email').value.trim();
      const password = document.getElementById('login-password').value;
      const errEl = document.getElementById('login-error');

      if (!email || !password) { errEl.textContent = 'E-poçt və şifrəni daxil edin!'; errEl.style.display = 'block'; return; }

      const attemptState = getLoginAttemptState(email);
      if (attemptState.lockUntil && Date.now() < attemptState.lockUntil) {
        const minsLeft = Math.ceil((attemptState.lockUntil - Date.now()) / 60000);
        errEl.textContent = t('login_locked_tpl', 'Çox sınaq oldu — {mins} dəqiqə sonra yenidən cəhd edin.').replace('{mins}', minsLeft);
        errEl.style.display = 'block';
        return;
      }

      errEl.style.display = 'none';
      const btn = document.getElementById('login-btn');
      btn.innerHTML = '<span class="spinner"></span>Gözləyin...';
      btn.disabled = true;

      const { data, error } = await sb.auth.signInWithPassword({ email, password });

      btn.innerHTML = 'Daxil ol';
      btn.disabled = false;

      if (error) {
        recordFailedLogin(email);
        const newState = getLoginAttemptState(email);
        if (newState.lockUntil && Date.now() < newState.lockUntil) {
          const minsLeft = Math.ceil((newState.lockUntil - Date.now()) / 60000);
          errEl.textContent = t('login_locked_tpl', 'Çox sınaq oldu — {mins} dəqiqə sonra yenidən cəhd edin.').replace('{mins}', minsLeft);
        } else {
          errEl.textContent = 'E-poçt və ya şifrə səhvdir.';
        }
        errEl.style.display = 'block';
      } else {
        clearLoginAttempts(email);
        toast('Sistemə daxil oldunuz!');
        currentEmail = email;
        const name = await resolveDisplayName(email, data.user?.user_metadata?.full_name);
        document.getElementById('home-greeting').textContent = 'Salam, ' + name.split(' ')[0];
        document.getElementById('profile-name-display').textContent = name;
        document.getElementById('profile-avatar-initials').textContent = name.charAt(0).toUpperCase();
        document.getElementById('profile-email-display').textContent = currentEmail;
        
        // Auto-fill form fields
        document.getElementById('f-name').value = name;
        document.getElementById('f-email').value = currentEmail;
        // Admin/Staff rol yoxlaması
        const role = await checkUserRole(currentEmail);
        if (role === 'admin' || role === 'staff') {
          await enterAdminPanel(role);
        } else {
          document.getElementById('navbar').style.display = 'flex';
          fetchDocumentsStatus(currentEmail);
          if (typeof restoreProfile === 'function') await restoreProfile(currentEmail);
          if (typeof loadMyConsultations === 'function') loadMyConsultations(); else refreshNotifBadge();
          showScreen('home');
        }
      }
    });

    // Çıxış
    document.getElementById('profile-logout-btn').addEventListener('click', async () => {
      if (sb) await sb.auth.signOut();
      window.location.reload();
    });

    /* ═══════════════════════════════════════════════════════════
       ŞİFRƏNİ BƏRPA ET
    ═══════════════════════════════════════════════════════════ */
    document.getElementById('go-forgot-password')?.addEventListener('click', () => {
      document.getElementById('login-error').style.display = 'none';
      showScreen('forgot-password');
    });
    document.getElementById('back-to-login-from-forgot')?.addEventListener('click', () => showScreen('login'));

    document.getElementById('send-reset-btn')?.addEventListener('click', async () => {
      const email = document.getElementById('forgot-email').value.trim();
      const errEl = document.getElementById('forgot-error');
      const okEl = document.getElementById('forgot-success');
      errEl.style.display = 'none';
      okEl.style.display = 'none';

      if (!email) { errEl.textContent = 'E-poçt ünvanını daxil edin!'; errEl.style.display = 'block'; return; }
      if (!sb) { errEl.textContent = 'Baza bağlantısı yoxdur.'; errEl.style.display = 'block'; return; }

      const btn = document.getElementById('send-reset-btn');
      btn.innerHTML = '<span class="spinner"></span>Göndərilir...';
      btn.disabled = true;

      // Canlı saytın sabit ünvanına yazılır — window.location.href-dən götürülsəydi,
      // bərpa istəyi localhost/sınaq ünvanından edildikdə emaildəki link də ora yazılır
      // və istifadəçi üçün açılmayan bir linkə çevrilirdi.
      const redirectTo = PRODUCTION_URL;
      let error = null;
      try {
        ({ error } = await sb.auth.resetPasswordForEmail(email, { redirectTo }));
      } catch (e) {
        error = e;
      }

      btn.innerHTML = 'Bağlantı göndər';
      btn.disabled = false;

      if (error) {
        // Diaqnostika üçün tam xəta konsola yazılır — "Failed to fetch" kimi
        // brauzer səviyyəli mesajlar adətən CORS/CSP/şəbəkə blokundan qaynaqlanır,
        // Supabase-in özü qaytardığı adi (məs. "email rate limit") xətalardan fərqlidir.
        console.error('Şifrə bərpa xətası:', { message: error.message, name: error.name, status: error.status, redirectTo, SUPABASE_URL, raw: error });
        const isNetworkFail = /fetch|network|load failed/i.test(error.message || '');
        errEl.textContent = isNetworkFail
          ? 'Serverə qoşulmaq alınmadı. İnternet bağlantınızı yoxlayın; problem davam edərsə brauzerin Console-undakı xətanı developerə göndərin.'
          : error.message;
        errEl.style.display = 'block';
        return;
      }
      okEl.textContent = 'Əgər bu e-poçt qeydiyyatdan keçibsə, bərpa linki göndərildi. Poçt qutunuzu yoxlayın.';
      okEl.style.display = 'block';
    });

    document.getElementById('update-password-btn')?.addEventListener('click', async () => {
      const pw1 = document.getElementById('new-password').value;
      const pw2 = document.getElementById('confirm-password').value;
      const errEl = document.getElementById('reset-password-error');
      errEl.style.display = 'none';

      if (!pw1 || pw1.length < 6) { errEl.textContent = 'Şifrə ən azı 6 simvol olmalıdır!'; errEl.style.display = 'block'; return; }
      if (pw1 !== pw2) { errEl.textContent = 'Şifrələr uyğun gəlmir!'; errEl.style.display = 'block'; return; }
      if (!sb) { errEl.textContent = 'Baza bağlantısı yoxdur.'; errEl.style.display = 'block'; return; }

      const btn = document.getElementById('update-password-btn');
      btn.innerHTML = '<span class="spinner"></span>Yenilənir...';
      btn.disabled = true;

      const { error } = await sb.auth.updateUser({ password: pw1 });

      btn.innerHTML = 'Şifrəni yenilə';
      btn.disabled = false;

      if (error) { errEl.textContent = error.message; errEl.style.display = 'block'; return; }

      toast('✓ Şifrəniz yeniləndi! Yenidən daxil olun.');
      await sb.auth.signOut();
      setTimeout(() => window.location.href = window.location.href.split('#')[0].split('?')[0], 1200);
    });

    // Supabase bərpa linkindən qayıdanda avtomatik "yeni şifrə" ekranını göstər
    if (sb) {
      sb.auth.onAuthStateChange((event) => {
        if (event === 'PASSWORD_RECOVERY') {
          document.getElementById('navbar').style.display = 'none';
          showScreen('reset-password');
        }
      });
    }

    /* ═══════════════════════════════════════════════════════════
       ONBOARDING NAVİQASİYASI
    ═══════════════════════════════════════════════════════════ */
    // Onboarding açılanda saxlanmış qaralamanı bərpa et
    function openOnboarding() {
      showScreen('onboarding');
      if (typeof restoreOnboardingDraft === 'function') restoreOnboardingDraft();
    }
    document.getElementById('go-onboarding')?.addEventListener('click', openOnboarding);
    document.querySelector('[data-close-onboarding]')?.addEventListener('click', () => showScreen('home'));
    document.querySelector('[data-back-to-onboarding]')?.addEventListener('click', openOnboarding);
    document.getElementById('profile-edit-btn')?.addEventListener('click', openOnboarding);

    /* ═══════════════════════════════════════════════════════════
       PROGRAM VERİLƏRİ (ölkə → universitetlər → ixtisaslar)
    ═══════════════════════════════════════════════════════════ */
    const DEPTS = ["Kompüter elmləri", "Biznes idarəetməsi", "Mühəndislik", "Tibb", "Hüquq",
      "Beynəlxalq münasibətlər", "İqtisadiyyat", "Psixologiya", "Dizayn və incəsənət",
      "Təbiət elmləri", "Jurnalistika", "Ekologiya", "Memarlıq", "Statistika"];

    function unis(arr) { const o = {}; arr.forEach(n => o[n] = DEPTS); return o; }

    // `DATA` işlək kataloqdur — baza dolu olsa oradan yenilənir.
    // `BUILTIN_DATA` isə daxili (ehtiyat) siyahıdır: baza boş/əlçatmaz olanda
    // tətbiq bununla işləyir, admin panelindən bazaya köçürmək də bundan gedir.
    const DATA = {
      "Almaniya": unis(["TU Berlin", "LMU Munich", "Heidelberg University", "RWTH Aachen", "Freie Universität Berlin", "University of Hamburg", "Karlsruhe Institute of Technology", "Technical University of Munich", "University of Freiburg", "University of Göttingen", "University of Cologne", "University of Bonn"]),
      "İsveç": unis(["Uppsala University", "KTH Royal Institute", "Lund University", "Stockholm University", "Chalmers University", "Linköping University", "Örebro University", "Umeå University", "Linnaeus University", "Karlstad University", "Mid Sweden University", "Jönköping University"]),
      "İtaliya": unis(["Politecnico di Milano", "Bocconi University", "Sapienza University", "University of Bologna", "Politecnico di Torino", "University of Padua", "University of Florence", "University of Pisa", "University of Naples Federico II", "University of Genoa", "University of Trento", "Ca' Foscari University of Venice"]),
      "Polşa": unis(["University of Warsaw", "Jagiellonian University", "Warsaw University of Technology", "AGH University", "Adam Mickiewicz University", "University of Wrocław", "Poznań University of Technology", "Silesian University of Technology", "University of Gdańsk", "University of Łódź", "Cracow University of Technology", "Nicolaus Copernicus University"]),
      "Fransa": unis(["Sorbonne Université", "Sciences Po", "HEC Paris", "École Polytechnique", "University of Lyon", "University of Strasbourg", "ESSEC Business School", "Grenoble Alpes University", "University of Bordeaux", "University of Montpellier", "EM Lyon Business School", "INSEAD"]),
      "Niderland": unis(["University of Amsterdam", "Delft University of Technology", "Utrecht University", "Leiden University", "Erasmus University Rotterdam", "Wageningen University", "Radboud University", "Vrije Universiteit Amsterdam", "University of Groningen", "Maastricht University", "Tilburg University", "Eindhoven University of Technology"]),
      "Böyük Britaniya": unis(["University of Oxford", "University of Cambridge", "Imperial College London", "University College London", "University of Edinburgh", "University of Manchester", "King's College London", "University of Warwick", "University of Bristol", "University of Glasgow", "University of Leeds", "University of Sheffield"]),
      "ABŞ": unis(["Harvard University", "Stanford University", "MIT", "UC Berkeley", "Arizona State University", "Yale University", "Princeton University", "University of Michigan", "Columbia University", "Cornell University", "University of Chicago", "UCLA"]),
      "Kanada": unis(["University of Toronto", "McGill University", "University of British Columbia", "University of Manitoba", "University of Waterloo", "University of Alberta", "Université de Montréal", "Queen's University", "Simon Fraser University", "University of Calgary", "Western University", "Dalhousie University"]),
      "Çexiya": unis(["Charles University", "Czech Technical University", "Masaryk University", "University of Economics Prague", "Palacký University", "University of West Bohemia", "Brno University of Technology", "University of Ostrava", "University of South Bohemia", "Silesian University in Opava", "University of Pardubice", "Technical University of Liberec"]),
      "Cənubi Koreya": unis(["Seoul National University", "Yonsei University", "Korea University", "KAIST", "Sungkyunkwan University", "Hanyang University", "Ewha Womans University", "Pohang University of Science and Technology", "Chung-Ang University", "Kyung Hee University", "Hongik University", "Inha University"]),
      "Türkiyə": unis(["Boğaziçi University", "Middle East Technical University", "Istanbul Technical University", "Koç University", "Sabancı University", "Bilkent University", "Hacettepe University", "Ankara University", "Yıldız Technical University", "Marmara University", "Ege University", "Gazi University"]),
      "Yaponiya": unis(["University of Tokyo", "Kyoto University", "Osaka University", "Waseda University", "Keio University", "Tohoku University", "Nagoya University", "Hokkaido University", "Kyushu University", "Hitotsubashi University", "Tokyo Institute of Technology", "International Christian University"]),
      "İspaniya": unis(["University of Barcelona", "Complutense University of Madrid", "IE University", "Universidad Autónoma de Madrid", "University of Navarra", "University of Valencia", "Pompeu Fabra University", "University of Granada", "University of Seville", "ESADE Business School", "Carlos III University of Madrid", "University of the Basque Country"]),
      "Avstriya": unis(["University of Vienna", "TU Wien", "University of Innsbruck", "WU Vienna", "University of Graz", "University of Salzburg", "Johannes Kepler University Linz", "Medical University of Vienna", "University of Klagenfurt", "Danube University Krems", "MODUL University Vienna", "FH Joanneum"]),
      "İsveçrə": unis(["ETH Zurich", "University of Zurich", "University of Geneva", "EPFL", "University of Basel", "University of Bern", "University of Lausanne", "University of St. Gallen", "University of Fribourg", "University of Lucerne", "USI Università della Svizzera Italiana", "University of Neuchâtel"]),
      "Finlandiya": unis(["University of Helsinki", "Aalto University", "University of Turku", "Tampere University", "LUT University", "University of Jyväskylä", "University of Oulu", "University of Eastern Finland", "University of Vaasa", "University of Lapland", "Häme University of Applied Sciences", "Metropolia University of Applied Sciences"]),
      "Norveç": unis(["University of Oslo", "NTNU", "University of Bergen", "BI Norwegian Business School", "UiT Arctic University of Norway", "University of Agder", "University of Stavanger", "Norwegian School of Economics", "Norwegian University of Life Sciences", "Nord University", "Molde University College", "OsloMet"]),
      "Danimarka": unis(["University of Copenhagen", "Technical University of Denmark", "Aarhus University", "Copenhagen Business School", "University of Southern Denmark", "Aalborg University", "Roskilde University", "IT University of Copenhagen", "VIA University College", "University College Copenhagen", "Design School Kolding", "Copenhagen School of Design and Technology"]),
      "Estoniya": unis(["University of Tartu", "Tallinn University of Technology", "Tallinn University", "Estonian Business School", "Estonian University of Life Sciences", "Estonian Academy of Arts", "TTK University of Applied Sciences", "Estonian Maritime Academy", "Tartu Health Care College", "Estonian Academy of Security Sciences", "Narva College", "Estonian Entrepreneurship University"]),
      "Qazaxıstan": unis(["Nazarbayev University", "Al-Farabi Kazakh National University", "KIMEP University", "Kazakh National Technical University", "Eurasian National University", "Kazakh-British Technical University", "Suleyman Demirel University", "Satbayev University", "Kazakh National Medical University", "Almaty Management University", "International IT University", "Karaganda State Technical University"]),
      "Özbəkistan": unis(["National University of Uzbekistan", "Tashkent State University of Economics", "Westminster International University in Tashkent", "Inha University in Tashkent", "Turin Polytechnic University in Tashkent", "Tashkent University of Information Technologies", "Samarkand State University", "Tashkent Medical Academy", "Urgench State University", "Bukhara State University", "Namangan State University", "Management Development Institute of Singapore in Tashkent"])
    };

    // Daxili siyahının dəyişməz nüsxəsi (baza yeniləməsindən sonra da qalır)
    const BUILTIN_DATA = JSON.parse(JSON.stringify(DATA));

    /* Universitet kataloqunu bazadan yükləyir. Cədvəl yoxdursa və ya boşdursa
       DATA daxili siyahı olaraq qalır — beləliklə tətbiq həmişə işlək olur. */
    async function loadUniversitiesFromDB() {
      if (!sb) return;
      const { data, error } = await sb.from('universities')
        .select('country, name')
        .eq('active', true);

      if (error) {
        console.warn('Universitet kataloqu bazadan yüklənmədi, daxili siyahı istifadə olunur:', error.message);
        return;
      }
      if (!data || !data.length) return;

      const fresh = {};
      data.forEach(u => {
        if (!fresh[u.country]) fresh[u.country] = {};
        fresh[u.country][u.name] = DEPTS;
      });

      Object.keys(DATA).forEach(k => delete DATA[k]);
      Object.keys(fresh).sort((a, b) => a.localeCompare(b, 'az')).forEach(k => { DATA[k] = fresh[k]; });

      // Kataloqdan asılı ekranları yenilə
      if (typeof renderCountryChips === 'function') { renderCountryChips(); renderFieldChips(); }
      if (typeof renderUniFilters === 'function') { renderUniFilters(); renderUniCatalog(); }
    }

    async function loadAchievements() {
      const listEl = document.getElementById('achievements-list');
      const emptyEl = document.getElementById('achievements-empty');
      if (!listEl || !sb) return;

      const { data, error } = await sb.from('achievements')
        .select('*')
        .eq('active', true)
        .order('sort_order', { ascending: true })
        .order('id', { ascending: true });

      if (error || !data || !data.length) {
        listEl.innerHTML = '';
        if (emptyEl) emptyEl.style.display = 'block';
        return;
      }
      if (emptyEl) emptyEl.style.display = 'none';
      listEl.innerHTML = data.map(a => `
        <div style="flex:0 0 auto; width:150px;">
          <img src="${escapeHtml(a.image_url)}" alt="${escapeHtml(a.caption)}" style="width:150px; height:110px; border-radius:10px; object-fit:cover; display:block;">
          <p style="font-size:11px; color:var(--ink-soft); margin:6px 0 0; line-height:1.4;">${escapeHtml(a.caption)}</p>
        </div>`).join('');
    }

    async function loadServices() {
      const listEl = document.getElementById('services-list');
      const emptyEl = document.getElementById('services-empty');
      if (!listEl || !sb) return;

      const { data, error } = await sb.from('services')
        .select('*')
        .eq('active', true)
        .order('sort_order', { ascending: true })
        .order('id', { ascending: true });

      if (error || !data || !data.length) {
        listEl.innerHTML = '';
        if (emptyEl) emptyEl.style.display = 'block';
        return;
      }
      if (emptyEl) emptyEl.style.display = 'none';
      listEl.innerHTML = data.map(s => `
        <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:10px; font-size:12.5px; color:var(--ink-soft); line-height:1.5;">
          <div style="display:flex; align-items:flex-start; gap:8px; min-width:0;">
            <span style="color:var(--teal); font-weight:600; flex-shrink:0;">•</span>
            <span>${escapeHtml(s.name)}</span>
          </div>
          ${s.price_text ? `<span style="flex-shrink:0; background:var(--teal-bg); color:var(--teal); font-weight:600; font-size:11px; padding:2px 8px; border-radius:100px; white-space:nowrap;">${escapeHtml(s.price_text)}</span>` : ''}
        </div>`).join('');
    }

    async function loadTeamMembers() {
      const listEl = document.getElementById('team-list');
      const emptyEl = document.getElementById('team-empty');
      if (!listEl || !sb) return;

      const { data, error } = await sb.from('team_members')
        .select('*')
        .eq('active', true)
        .order('sort_order', { ascending: true })
        .order('id', { ascending: true });

      if (error || !data || !data.length) {
        listEl.innerHTML = '';
        if (emptyEl) emptyEl.style.display = 'block';
        return;
      }
      if (emptyEl) emptyEl.style.display = 'none';
      listEl.innerHTML = data.map(m => {
        const initials = (m.name || '?').trim().split(/\s+/).map(w => w[0] || '').slice(0, 2).join('').toUpperCase();
        const photo = m.photo_url
          ? `<img src="${escapeHtml(m.photo_url)}" alt="${escapeHtml(m.name)}" style="width:44px; height:44px; border-radius:50%; object-fit:cover; flex-shrink:0;">`
          : `<div style="width:44px; height:44px; border-radius:50%; background:var(--navy); color:var(--gold); display:flex; align-items:center; justify-content:center; font-family:'Fraunces',serif; font-weight:600; font-size:14px; flex-shrink:0;">${escapeHtml(initials)}</div>`;
        return `
        <div style="display:flex; align-items:center; gap:10px;">
          ${photo}
          <div style="min-width:0;">
            <p style="font-size:13px; font-weight:600; color:var(--ink); margin:0;">${escapeHtml(m.name)}</p>
            ${m.title ? `<p style="font-size:11.5px; color:var(--ink-soft); margin:1px 0 0;">${escapeHtml(m.title)}</p>` : ''}
          </div>
        </div>`;
      }).join('');
    }

    async function loadPartnerUniversities() {
      const listEl = document.getElementById('partner-unis-list');
      const emptyEl = document.getElementById('partner-unis-empty');
      if (!listEl || !sb) return;

      const { data, error } = await sb.from('partner_universities')
        .select('*')
        .eq('active', true)
        .order('sort_order', { ascending: true })
        .order('id', { ascending: true });

      if (error || !data || !data.length) {
        listEl.innerHTML = '';
        if (emptyEl) emptyEl.style.display = 'block';
        return;
      }
      if (emptyEl) emptyEl.style.display = 'none';
      listEl.innerHTML = data.map(u => `
        <div style="display:flex; align-items:flex-start; gap:8px; font-size:12.5px; color:var(--ink-soft); line-height:1.5;">
          <span style="color:var(--teal); font-weight:600; flex-shrink:0;">•</span>
          <span><b style="color:var(--ink); font-weight:600;">${escapeHtml(u.name)}</b>${u.country ? ' — ' + escapeHtml(u.country) : ''}</span>
        </div>`).join('');
    }

    /* Valideyn üçün girişsiz, yalnız-oxu görünüş — URL-də ?parent=TOKEN
       olanda splash/login əvəzinə birbaşa bu ekran göstərilir (bax: skriptin
       sonundakı çağırışa). Bütün məlumat security-definer RPC-dən gəlir,
       heç bir cədvələ birbaşa giriş yoxdur. */
    async function initParentView(token) {
      showScreen('parent-view');
      const loadingEl = document.getElementById('parent-view-loading');
      const errorEl = document.getElementById('parent-view-error');
      const contentEl = document.getElementById('parent-view-content');
      errorEl.style.display = 'none';
      contentEl.style.display = 'none';
      if (!sb) { loadingEl.style.display = 'none'; errorEl.style.display = 'block'; return; }

      const { data, error } = await sb.rpc('get_parent_view', { p_token: token });
      loadingEl.style.display = 'none';

      if (error || !data || data.error) {
        errorEl.style.display = 'block';
        return;
      }

      document.getElementById('parent-view-name').textContent = data.student_name || '—';
      contentEl.style.display = 'block';

      const total = data.docs_total || 0;
      const done = data.docs_done || 0;
      const pct = total ? Math.round((done / total) * 100) : 0;
      document.getElementById('parent-view-doc-pct').textContent = pct + '%';
      document.getElementById('parent-view-doc-fill').style.width = pct + '%';
      document.getElementById('parent-view-doc-detail').textContent =
        t('parent_view_doc_tpl', '{done}/{total} sənəd hazırdır').replace('{done}', done).replace('{total}', total);

      const countries = Array.isArray(data.target_countries) ? data.target_countries : [];
      document.getElementById('parent-view-countries').textContent =
        countries.length ? countries.join(', ') : t('parent_view_none', 'Hələ seçilməyib');

      const consultEl = document.getElementById('parent-view-consult');
      if (data.consult_advisor && data.consult_date) {
        consultEl.textContent = t('notif_confirmed_tpl', '{date} tarixində saat {time}-da {advisor} ilə görüşəcəksiniz')
          .replace('{date}', data.consult_date).replace('{time}', data.consult_time).replace('{advisor}', data.consult_advisor);
      } else {
        consultEl.textContent = t('parent_view_none', 'Hələ seçilməyib');
      }

      const trialExams = Array.isArray(data.trial_exams) ? data.trial_exams : [];
      const trialExamsCard = document.getElementById('parent-view-trialexams-card');
      if (trialExams.length) {
        trialExamsCard.style.display = 'block';
        document.getElementById('parent-view-trialexams-list').innerHTML = trialExams.map(ex => {
          const isPaid = ex.payment_status === 'ödənilib';
          const resultLine = trialExamResultLine(ex);
          return `
          <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap;">
            <div style="min-width:0;">
              <p style="font-size:13px; font-weight:600; color:var(--ink); margin:0;">${escapeHtml(ex.exam_name)}</p>
              ${resultLine ? `<p style="font-size:12px; color:var(--teal); font-weight:600; margin:2px 0 0;">${escapeHtml(resultLine)}</p>` : ''}
            </div>
            <span style="font-size:11px; font-weight:600; color:${isPaid ? 'var(--teal)' : 'var(--gold-deep)'}; background:${isPaid ? 'var(--teal-bg)' : 'var(--surface-2)'}; padding:3px 9px; border-radius:100px; white-space:nowrap; flex-shrink:0;">${isPaid ? escapeHtml(t('trialexams_paid', 'Ödənilib')) : escapeHtml(t('trialexams_pending', 'Gözlənilir'))}</span>
          </div>`;
        }).join('');
      } else {
        trialExamsCard.style.display = 'none';
      }
    }

    async function loadNews() {
      const listEl = document.getElementById('news-list');
      const emptyEl = document.getElementById('news-empty');
      if (!listEl || !sb) return;

      const { data, error } = await sb.from('news_posts')
        .select('*')
        .eq('active', true)
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: false });

      if (error || !data || !data.length) {
        listEl.innerHTML = '';
        if (emptyEl) emptyEl.style.display = 'block';
        return;
      }
      if (emptyEl) emptyEl.style.display = 'none';
      listEl.innerHTML = data.map(n => {
        const when = n.created_at ? new Date(n.created_at).toLocaleDateString('az-AZ') : '';
        return `
        <div style="border-left:3px solid var(--teal); padding-left:10px;">
          <p style="font-size:13px; font-weight:600; color:var(--ink); margin:0;">${escapeHtml(n.title)}</p>
          ${n.body ? `<p style="font-size:12px; color:var(--ink-soft); margin:3px 0 0; line-height:1.5;">${escapeHtml(n.body)}</p>` : ''}
          ${when ? `<p style="font-size:10.5px; color:var(--ink-soft); margin:4px 0 0;">${escapeHtml(when)}</p>` : ''}
        </div>`;
      }).join('');
    }

    // Tələbə ödənişli sınaq imtahanları kataloqunu görür və qeydiyyatdan keçir.
    // Ödəniş nağd/bank köçürməsi ilə OFFLINE aparılır, admin panelindən statusu
    // əl ilə "ödənilib" edir — burada kart ödənişi YOXDUR.
    async function loadTrialExams() {
      const listEl = document.getElementById('trialexams-list');
      const emptyEl = document.getElementById('trialexams-empty');
      if (!listEl || !sb) return;

      const { data, error } = await sb.from('trial_exams')
        .select('*')
        .eq('active', true)
        .order('sort_order', { ascending: true })
        .order('id', { ascending: true });

      if (error || !data || !data.length) {
        listEl.innerHTML = '';
        if (emptyEl) emptyEl.style.display = 'block';
        return;
      }
      if (emptyEl) emptyEl.style.display = 'none';

      let regByExam = {};
      if (currentEmail) {
        const { data: regs } = await sb.from('trial_exam_registrations')
          .select('*')
          .eq('student_email', currentEmail);
        (regs || []).forEach(r => { regByExam[r.trial_exam_id] = r; });
      }

      listEl.innerHTML = data.map(ex => {
        const reg = regByExam[ex.id];
        let actionHtml;
        if (!reg) {
          actionHtml = `<button class="admin-btn-primary trialexam-register-btn" data-id="${ex.id}" style="padding:7px 14px; font-size:12px;">${escapeHtml(t('trialexams_register', 'Qeydiyyatdan keç'))}</button>`;
        } else if (reg.payment_status === 'ödənilib') {
          const alreadyTaken = reg.total_questions !== null && reg.total_questions !== undefined;
          actionHtml = alreadyTaken
            ? `<span style="font-size:11px; font-weight:600; color:var(--teal); background:var(--teal-bg); padding:4px 10px; border-radius:100px; white-space:nowrap;">✓ ${escapeHtml(t('trialexams_paid', 'Ödənilib'))}</span>`
            : `<button class="admin-btn-primary trialexam-start-btn" data-exam-id="${ex.id}" data-exam-name="${escapeHtml(ex.name)}" style="padding:7px 14px; font-size:12px;">🎯 ${escapeHtml(t('trialexams_start', 'Sınağa başla'))}</button>`;
        } else {
          actionHtml = `
            <div style="display:flex; align-items:center; gap:6px;">
              <span style="font-size:11px; font-weight:600; color:var(--gold-deep); background:var(--surface-2); padding:4px 10px; border-radius:100px; white-space:nowrap;">${escapeHtml(t('trialexams_pending', 'Gözlənilir'))}</span>
              <button class="admin-action-btn danger trialexam-cancel-btn" data-reg-id="${reg.id}" style="font-size:11px;">${escapeHtml(t('trialexams_cancel', 'Ləğv et'))}</button>
            </div>`;
        }
        const resultLine = reg ? trialExamResultLine(reg) : '';
        return `
        <div>
          <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
            <p style="font-size:13px; font-weight:600; color:var(--ink); margin:0;">${escapeHtml(ex.name)}</p>
            ${ex.price_text ? `<span style="flex-shrink:0; background:var(--teal-bg); color:var(--teal); font-weight:600; font-size:11px; padding:2px 8px; border-radius:100px; white-space:nowrap;">${escapeHtml(ex.price_text)}</span>` : ''}
          </div>
          ${ex.description ? `<p style="font-size:12px; color:var(--ink-soft); margin:4px 0 6px; line-height:1.5;">${escapeHtml(ex.description)}</p>` : ''}
          ${resultLine ? `<p style="font-size:12px; color:var(--teal); font-weight:600; margin:4px 0 0;">🎯 ${escapeHtml(resultLine)}</p>` : ''}
          <div style="display:flex; justify-content:flex-end; margin-top:6px;">${actionHtml}</div>
        </div>`;
      }).join('<div class="admin-divider" style="margin:4px 0;"></div>');

      listEl.querySelectorAll('.trialexam-register-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!sb || !currentEmail) return;
          btn.disabled = true; btn.textContent = '...';
          const { error } = await sb.from('trial_exam_registrations')
            .insert({ trial_exam_id: parseInt(btn.dataset.id, 10), student_email: currentEmail });
          if (error) { toast('Xəta: ' + error.message, true); loadTrialExams(); return; }
          toast('✓ ' + t('trialexams_registered_toast', 'Qeydiyyatdan keçdiniz'));
          loadTrialExams();
        });
      });
      listEl.querySelectorAll('.trialexam-cancel-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!sb) return;
          if (!confirm(t('trialexams_cancel_confirm', 'Qeydiyyatı ləğv etmək istədiyinizə əminsiniz?'))) return;
          await sb.from('trial_exam_registrations').delete().eq('id', btn.dataset.regId);
          toast('✓ ' + t('trialexams_cancelled_toast', 'Ləğv edildi'));
          loadTrialExams();
        });
      });
      listEl.querySelectorAll('.trialexam-start-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          closeModal('trialexams-modal');
          startTrialExam(parseInt(btn.dataset.examId, 10), btn.dataset.examName);
        });
      });
    }

    /* ═══════════════════════════════════════════════════════════
       SINAQ HƏLLİ — tam interaktiv sual-cavab axını (tələbə)
       ──────────────────────────────────────────────────────────
       Suallar get_trial_exam_questions() ilə (doğru cavab OLMADAN)
       gətirilir, cavablar submit_trial_exam_answers() ilə göndərilir —
       yoxlama tamamilə serverdə olur, doğru cavab heç vaxt brauzerə
       ötürülmür.
    ═══════════════════════════════════════════════════════════ */
    let quizState = null;

    async function startTrialExam(examId, examName) {
      document.getElementById('navbar').style.display = 'none';
      showScreen('trialexam-take');
      document.getElementById('trialexam-take-exam-name').textContent = examName || '—';
      document.getElementById('trialexam-take-body').style.display = 'none';
      document.getElementById('trialexam-take-empty').style.display = 'none';
      document.getElementById('trialexam-take-blocked').style.display = 'none';
      document.getElementById('trialexam-take-result').style.display = 'none';

      if (!sb) return;
      const { data, error } = await sb.rpc('get_trial_exam_questions', { p_trial_exam_id: examId });

      if (error || !data) {
        document.getElementById('trialexam-take-blocked-title').textContent = t('trialexams_error_title', 'Xəta baş verdi');
        document.getElementById('trialexam-take-blocked-sub').textContent = t('trialexams_error_sub', 'Bir az sonra yenidən cəhd edin.');
        document.getElementById('trialexam-take-blocked').style.display = 'block';
        return;
      }
      if (data.error === 'not_eligible') {
        document.getElementById('trialexam-take-blocked-title').textContent = t('trialexams_not_eligible_title', 'Bu sınağa hələ girişiniz yoxdur');
        document.getElementById('trialexam-take-blocked-sub').textContent = t('trialexams_not_eligible_sub', 'Ödəniş təsdiqləndikdən sonra sınağa başlaya biləcəksiniz.');
        document.getElementById('trialexam-take-blocked').style.display = 'block';
        return;
      }
      if (data.error === 'already_taken') {
        document.getElementById('trialexam-take-blocked-title').textContent = t('trialexams_already_taken_title', 'Bu sınağı artıq vermisiniz');
        document.getElementById('trialexam-take-blocked-sub').textContent = t('trialexams_already_taken_sub', 'Nəticənizi "Sınaqlar" bölməsində görə bilərsiniz.');
        document.getElementById('trialexam-take-blocked').style.display = 'block';
        return;
      }
      const questions = Array.isArray(data.questions) ? data.questions : [];
      if (!questions.length) {
        document.getElementById('trialexam-take-empty').style.display = 'block';
        return;
      }

      quizState = { registrationId: data.registration_id, questions, currentIndex: 0, answers: {} };
      document.getElementById('trialexam-take-body').style.display = 'block';
      renderQuizQuestion();
    }

    function exitTrialExam() {
      quizState = null;
      document.getElementById('navbar').style.display = 'flex';
      showScreen('home');
      loadTrialExams();
    }

    function renderQuizQuestion() {
      if (!quizState) return;
      const { questions, currentIndex, answers } = quizState;
      const q = questions[currentIndex];
      const total = questions.length;

      document.getElementById('trialexam-take-progress').textContent = `${currentIndex + 1}/${total}`;
      document.getElementById('trialexam-take-progress-fill').style.width = Math.round(((currentIndex + 1) / total) * 100) + '%';

      const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
      const selected = answers[q.id];
      const optionsHtml = (q.options || []).map((opt, i) => `
        <div class="quiz-option ${selected === i ? 'sel' : ''}" data-index="${i}">
          <span class="quiz-option-letter">${letters[i] || (i + 1)}</span>
          <span>${escapeHtml(opt)}</span>
        </div>`).join('');

      document.getElementById('trialexam-take-question-area').innerHTML = `
        <p style="font-size:15px; font-weight:600; color:var(--ink); margin:0 0 16px; line-height:1.5;">${escapeHtml(q.question_text)}</p>
        ${optionsHtml}`;

      document.querySelectorAll('#trialexam-take-question-area .quiz-option').forEach(el => {
        el.addEventListener('click', () => {
          quizState.answers[q.id] = parseInt(el.dataset.index, 10);
          renderQuizQuestion();
        });
      });

      document.getElementById('trialexam-take-prev-btn').style.visibility = currentIndex === 0 ? 'hidden' : 'visible';
      const isLast = currentIndex === total - 1;
      document.getElementById('trialexam-take-next-btn').style.display = isLast ? 'none' : 'block';
      document.getElementById('trialexam-take-submit-btn').style.display = isLast ? 'block' : 'none';
    }

    document.getElementById('trialexam-take-prev-btn')?.addEventListener('click', () => {
      if (!quizState || quizState.currentIndex === 0) return;
      quizState.currentIndex--;
      renderQuizQuestion();
    });
    document.getElementById('trialexam-take-next-btn')?.addEventListener('click', () => {
      if (!quizState || quizState.currentIndex >= quizState.questions.length - 1) return;
      quizState.currentIndex++;
      renderQuizQuestion();
    });
    document.getElementById('trialexam-take-submit-btn')?.addEventListener('click', async () => {
      if (!quizState || !sb) return;
      const unanswered = quizState.questions.filter(q => quizState.answers[q.id] === undefined).length;
      const confirmMsg = unanswered
        ? t('trialexams_submit_confirm_unanswered', '{n} suala cavab verməmisiniz. Yenə də təqdim etmək istəyirsiniz?').replace('{n}', unanswered)
        : t('trialexams_submit_confirm', 'Sınağı təqdim etdikdən sonra sualları yenidən görə bilməyəcəksiniz. Əminsiniz?');
      if (!confirm(confirmMsg)) return;

      const btn = document.getElementById('trialexam-take-submit-btn');
      btn.disabled = true; btn.textContent = '...';
      const p_answers = quizState.questions.map(q => ({
        question_id: q.id,
        selected_index: quizState.answers[q.id] === undefined ? -1 : quizState.answers[q.id]
      }));
      const { data, error } = await sb.rpc('submit_trial_exam_answers', {
        p_registration_id: quizState.registrationId,
        p_answers
      });
      btn.disabled = false; btn.textContent = t('trialexams_submit', 'Təqdim et');

      if (error || !data || data.error) {
        toast(t('trialexams_error_sub', 'Bir az sonra yenidən cəhd edin.'), true);
        return;
      }

      document.getElementById('trialexam-take-body').style.display = 'none';
      const pct = data.total_questions ? Math.round((data.correct_count / data.total_questions) * 100) : 0;
      document.getElementById('trialexam-take-result-pct').textContent = pct + '%';
      document.getElementById('trialexam-take-result-detail').textContent =
        `${data.correct_count}/${data.total_questions} ${t('trialexams_correct_short', 'doğru')}${data.wrong_count !== null ? ', ' + data.wrong_count + ' ' + t('trialexams_wrong_short', 'səhv') : ''}`;
      document.getElementById('trialexam-take-result').style.display = 'block';
      quizState = null;
    });

    document.getElementById('trialexam-take-exit-btn')?.addEventListener('click', exitTrialExam);
    document.getElementById('trialexam-take-empty-back-btn')?.addEventListener('click', exitTrialExam);
    document.getElementById('trialexam-take-blocked-back-btn')?.addEventListener('click', exitTrialExam);
    document.getElementById('trialexam-take-done-btn')?.addEventListener('click', exitTrialExam);

    let selCountries = [], selUnis = [], selFields = [];

    function renderCountryChips() {
      const c = document.getElementById('f-countries');
      if (!c) return;
      c.innerHTML = '';
      Object.keys(DATA).forEach(country => {
        const ch = document.createElement('div');
        ch.className = 'chip' + (selCountries.includes(country) ? ' sel' : '');
        ch.textContent = country;
        ch.onclick = () => {
          if (selCountries.includes(country)) selCountries = selCountries.filter(x => x !== country);
          else if (selCountries.length < 5) selCountries.push(country);
          renderCountryChips(); renderFieldChips();
          if (typeof saveOnboardingDraft === 'function') saveOnboardingDraft();
        };
        c.appendChild(ch);
      });
    }
    function renderFieldChips() {
      const c = document.getElementById('f-fields');
      if (!c) return;
      c.innerHTML = '';
      DEPTS.forEach(d => {
        const ch = document.createElement('div');
        ch.className = 'chip' + (selFields.includes(d) ? ' sel' : '');
        ch.textContent = d;
        ch.onclick = () => {
          if (selFields.includes(d)) selFields = selFields.filter(x => x !== d);
          else if (selFields.length < 5) selFields.push(d);
          renderFieldChips();
          if (typeof saveOnboardingDraft === 'function') saveOnboardingDraft();
        };
        c.appendChild(ch);
      });
    }
    renderCountryChips(); renderFieldChips();
    // Kataloqu bazadan yenilə (varsa) — səhifə açılışını bloklamadan
    loadUniversitiesFromDB();
    loadAchievements();
    loadServices();
    loadTeamMembers();
    loadPartnerUniversities();
    loadNews();
    loadTrialExams();

    // Valideyn linki ilə açılıbsa (?parent=TOKEN), splash/login əvəzinə
    // birbaşa yalnız-oxu görünüşü göstər.
    const __parentToken = new URLSearchParams(window.location.search).get('parent');
    if (__parentToken) initParentView(__parentToken);

    async function restoreProfile(email) {
      if (!sb || !email) return;
      // .maybeSingle() istifadə olunur ki, profili hələ olmayan hesablar (məs. admin
      // özü "tələbə kimi bax" edəndə) xəta yaratmadan sadəcə boş qalsın.
      const { data, error } = await sb.from('profiles').select('*').eq('email', email).maybeSingle();
      if (error || !data) return;

      if (data.target_countries) selCountries = data.target_countries;
      if (data.target_universities) selUnis = data.target_universities;
      if (data.fields) selFields = data.fields;
      
      if (data.father_name) document.getElementById('f-father-name').value = data.father_name;
      if (data.phone) document.getElementById('f-phone').value = data.phone;
      if (data.budget) setBudgetValue(data.budget);

      if (data.level) {
        document.querySelectorAll('#f-level .radio-opt').forEach(o => {
          if (o.dataset.value === data.level) {
            document.querySelectorAll('#f-level .radio-opt').forEach(x => x.classList.remove('sel'));
            o.classList.add('sel');
          }
        });
      }

      if (data.exams && Array.isArray(data.exams)) {
        document.querySelectorAll('#f-exams .chip').forEach(ch => {
          if (data.exams.includes(ch.textContent)) ch.classList.add('sel');
          else ch.classList.remove('sel');
        });
        // Saxlanmış balları "IELTS: 7.0, SAT: 1200" formatından geri oxu
        const savedScores = {};
        if (data.score && data.score !== 'qeyd olunmayıb') {
          data.score.split(', ').forEach(part => {
            const [ex, val] = part.split(': ');
            if (ex && val) savedScores[ex] = val;
          });
        }
        rebuildScoreInputs(savedScores);
      }

      document.getElementById('profile-level').textContent = data.level || '—';
      document.getElementById('profile-field').textContent = selFields.length ? selFields.join(', ') : '—';
      document.getElementById('profile-budget').textContent = data.budget || '—';
      document.getElementById('profile-score').textContent = data.score || '—';
      document.getElementById('profile-countries').textContent = selCountries.length ? selCountries.join(', ') : '—';

      syncHomeSummary();

      if (typeof renderCountryChips === 'function') {
        renderCountryChips();
        renderFieldChips();
      }
    }

    /* Ana səhifədəki "boarding pass", universitet sayı və seçilmiş universitet
       siyahısını hazırkı selCountries/selUnis/selFields ilə sinxronlaşdırır.
       Onboarding təsdiqindən, profil bərpasından və Universitetlər ekranından çağırılır. */
    function syncHomeSummary() {
      const uniCount = document.getElementById('home-uni-count');
      if (uniCount) uniCount.textContent = selUnis.length;
      updateNextStepCard();

      const selectedUnisContainer = document.getElementById('home-selected-unis-container');
      const selectedUnisList = document.getElementById('home-selected-unis-list');
      if (selUnis.length > 0 && selectedUnisContainer) {
        selectedUnisContainer.style.display = 'block';
        selectedUnisList.innerHTML = selUnis.map(u => {
          const country = Object.keys(DATA).find(co => DATA[co] && DATA[co][u]) || 'İstifadəçi seçimi';
          return `
      <div class="card" style="padding: 12px; margin-bottom: 10px;">
        <div class="uni-row" style="align-items: center;">
          <div>
            <p class="uni-name" style="margin-bottom: 2px; font-size: 14px;">${escapeHtml(u)}</p>
            <p class="uni-loc" style="font-size: 11px;">${escapeHtml(country)}</p>
          </div>
        </div>
      </div>`;
        }).join('');
      } else if (selectedUnisContainer) {
        selectedUnisContainer.style.display = 'none';
      }
    }

    /* ═══════════════════════════════════════════════════════════
       "NÖVBƏTİ ADDIM" KARTI
       ──────────────────────────────────────────────────────────
       Tələbənin hansı mərhələdə olduğunu müəyyən edib ona bir
       konkret addım göstərir. Əvvəlki "boarding pass" kartı yeni
       istifadəçidə "Seçilməyib / Seçilməyib / —" göstərirdi —
       yəni boş və faydasız idi.
    ═══════════════════════════════════════════════════════════ */
    let nextStepAction = null;
    let lastMyConsultations = [];

    function updateNextStepCard() {
      const card = document.getElementById('next-step-card');
      if (!card) return;
      const titleEl = document.getElementById('next-step-title');
      const subEl = document.getElementById('next-step-sub');
      const metaEl = document.getElementById('next-step-meta');
      const btnEl = document.getElementById('next-step-btn');

      const docItems = document.querySelectorAll('#doc-list .doc-item');
      const docsTotal = docItems.length;
      const docsDone = document.querySelectorAll('#doc-list .doc-item[data-status="done"]').length;
      const hasProfile = selCountries.length > 0 && selFields.length > 0;
      const hasUnis = selUnis.length > 0;
      const hasConsult = lastMyConsultations.some(c => apptStatusMeta(c).status !== 'rejected');

      card.classList.remove('done');
      metaEl.style.display = 'none';
      metaEl.innerHTML = '';

      let state;
      if (!hasProfile) {
        state = { title: t('ns_fill_profile_title', 'Profilini doldur'), sub: t('ns_fill_profile_sub', 'Ölkə, ixtisas və büdcəni qeyd et ki, sənə uyğun universitetləri göstərək.'), btn: t('fill_form', 'Formu doldur'), action: 'onboarding' };
      } else if (!hasUnis) {
        state = { title: t('ns_pick_unis_title', 'Universitet seç'), sub: t('ns_pick_unis_sub', 'Profilinə uyğun universitetlərə bax və maraqlandıqlarını seç.'), btn: t('pick_unis_btn', 'Universitetlərə bax'), action: 'unis' };
      } else if (docsTotal && docsDone === 0) {
        state = { title: t('ns_first_doc_title', 'İlk sənədini yüklə'), sub: t('ns_first_doc_sub', 'Müraciət üçün lazım olan sənədləri telefonla şəkil çəkib yükləyə bilərsən.'), btn: t('ns_docs_btn', 'Sənədlərə keç'), action: 'docs' };
      } else if (docsTotal && docsDone < docsTotal) {
        const left = docsTotal - docsDone;
        state = {
          title: t('ns_docs_left_title_tpl', '{left} sənəd qalıb').replace('{left}', left),
          sub: t('ns_docs_left_sub_tpl', '{total} sənəddən {done}-i hazırdır. Qalanlarını da yüklə.').replace('{total}', docsTotal).replace('{done}', docsDone),
          btn: t('ns_docs_btn', 'Sənədlərə keç'), action: 'docs'
        };
      } else if (!hasConsult) {
        state = { title: t('ns_consult_title', 'Konsultasiya al'), sub: t('ns_consult_sub', 'Sənədlərin hazırdır. İndi məsləhətçi ilə görüş planlaşdır.'), btn: t('ns_consult_btn', 'Görüş planlaşdır'), action: 'consult' };
      } else {
        card.classList.add('done');
        state = { title: t('ns_done_title', 'Hər şey qaydasındadır'), sub: t('ns_done_sub', 'Profilin, sənədlərin və görüşün hazırdır. Növbəti addımları məsləhətçin sənə deyəcək.'), btn: t('ns_done_btn', 'Görüşlərimə bax'), action: 'consult' };
      }

      titleEl.textContent = state.title;
      subEl.textContent = state.sub;
      btnEl.textContent = state.btn;
      nextStepAction = state.action;

      // Əlavə kontekst: ən yaxın son tarix və sənəd sayğacı
      const chips = [];
      if (docsTotal) chips.push(`<span>${escapeHtml(t('ns_docs_chip_tpl', 'Sənədlər {done}/{total}').replace('{done}', docsDone).replace('{total}', docsTotal))}</span>`);
      const nearest = nearestDocDeadline();
      if (nearest) {
        chips.push(`<span class="${nearest.overdue ? 'warn' : ''}">${escapeHtml(nearest.text)}</span>`);
      }
      if (chips.length) { metaEl.innerHTML = chips.join(''); metaEl.style.display = 'flex'; }
    }

    // Yüklənməmiş sənədlər arasında ən yaxın son tarixi tapır
    function nearestDocDeadline() {
      if (!docTemplatesCache) return null;
      const doneNames = new Set(
        Array.from(document.querySelectorAll('#doc-list .doc-item[data-status="done"] .doc-name'))
          .map(el => el.textContent));
      const today = new Date(); today.setHours(0, 0, 0, 0);

      const upcoming = docTemplatesCache
        .filter(t => t.due_date && !doneNames.has(t.doc_name))
        .filter(t => !t.country || selCountries.includes(t.country))
        .map(t => ({ name: t.doc_name, date: new Date(t.due_date + 'T00:00:00') }))
        .filter(t => !isNaN(t.date))
        .sort((a, b) => a.date - b.date);

      if (!upcoming.length) return null;
      const n = upcoming[0];
      const days = Math.round((n.date - today) / 86400000);
      if (days < 0) return { overdue: true, text: t('ns_deadline_overdue_tpl', '{name} — vaxtı keçib').replace('{name}', n.name) };
      if (days === 0) return { overdue: true, text: t('ns_deadline_today_tpl', '{name} — son gün').replace('{name}', n.name) };
      return { overdue: days <= 3, text: t('ns_deadline_days_tpl', '{name} — {days} gün qalıb').replace('{name}', n.name).replace('{days}', days) };
    }

    document.getElementById('next-step-btn')?.addEventListener('click', () => {
      if (!nextStepAction) return;
      if (nextStepAction === 'onboarding') { openOnboarding(); return; }
      const btn = document.querySelector(`.navbtn[data-target="${nextStepAction}"]`);
      if (btn) btn.click(); else showScreen(nextStepAction);
    });

    /* ═══════════════════════════════════════════════════════════
       SƏNƏD İRƏLİLƏYİŞ
    ═══════════════════════════════════════════════════════════ */
    function updateDocProgress() {
      const items = document.querySelectorAll('#doc-list .doc-item');
      if (items.length === 0) return;
      const done = document.querySelectorAll('#doc-list .doc-item[data-status="done"]').length;
      const pct = Math.round(done / items.length * 100);

      const progressFill = document.getElementById('doc-progress-fill');
      if (progressFill) progressFill.style.width = pct + '%';

      const progressPct = document.getElementById('doc-progress-pct');
      if (progressPct) progressPct.textContent = pct + '%';

      const docCount = document.getElementById('home-doc-count');
      if (docCount) docCount.textContent = done;

      updateNextStepCard();
    }
    function bindDocItem(item) {
      const inp = item.querySelector('.doc-file');
      if (inp && !inp.dataset.bound) {
        inp.dataset.bound = 'true';
        inp.addEventListener('change', async () => {
          if (!inp.files || !inp.files.length) return;
          const file = inp.files[0];
          const docName = item.querySelector('.doc-name').textContent;

          const MAX_UPLOAD_MB = 15;
          if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
            toast(`Fayl çox böyükdür (maks. ${MAX_UPLOAD_MB}MB). Zəhmət olmasa daha kiçik fayl seçin.`, true);
            inp.value = '';
            return;
          }

          const stamp = item.querySelector('.stamp');
          stamp.innerHTML = '<span class="spinner" style="width:14px; height:14px; border-width:2px; margin-right:0;"></span>';
          stamp.className = 'stamp';

          let fileUrl = null;
          if (sb && currentEmail) {
            const fileExt = file.name.split('.').pop();
            const safeDocName = docName.replace(/[^a-zA-Z0-9]/g, '_');
            const fileName = `${currentEmail}/${safeDocName}_${Date.now()}.${fileExt}`;

            const { error } = await sb.storage.from('Documents').upload(fileName, file);
            if (error) {
              toast('Xəta: ' + error.message, true);
              console.error('Supabase Storage Error:', error);
              stamp.innerHTML = '&#9675;';
              return;
            }
            // Bucket private ola bilər — public URL əvəzinə saxlama yolunu (path) saxlayırıq,
            // baxış zamanı ehtiyac olanda müvəqqəti "signed URL" yaradılır (bax: getSignedDocUrl).
            fileUrl = fileName;
          }

          item.dataset.status = 'done';
          stamp.className = 'stamp done';
          stamp.innerHTML = '&#10003;';

          const dueEl = item.querySelector('.doc-due');
          if (!dueEl.dataset.default) dueEl.dataset.default = dueEl.textContent;
          dueEl.style.color = '';
          dueEl.textContent = 'Yükləndi — ' + file.name;

          const rejectNote = item.querySelector('.doc-reject-note');
          if (rejectNote) rejectNote.remove();

          const lbl = item.querySelector('.upload-btn');
          if (lbl) lbl.style.display = 'none';

          let delBtn = item.querySelector('.doc-del-btn');
          if (!delBtn) {
            delBtn = document.createElement('button');
            delBtn.className = 'doc-del-btn pill-btn danger';
            delBtn.textContent = t('doc_delete_wrong', 'Səhv faylı sil');
            delBtn.style.cssText = 'margin-top:6px;';

            delBtn.onclick = async () => {
              item.dataset.status = 'pending';
              stamp.className = 'stamp pending';
              stamp.innerHTML = '&#9675;';
              dueEl.textContent = dueEl.dataset.default;
              if (lbl) {
                lbl.style.display = '';
                const lblText = lbl.querySelector('.upload-btn-label');
                if (lblText) lblText.textContent = t('upload', 'Yüklə');
              }
              delBtn.style.display = 'none';
              inp.value = '';
              updateDocProgress();
              await dbSaveDocStatus(currentEmail, docName, 'pending', null);
              toast('Fayl silindi. Yenisini yükləyə bilərsiniz.');
            };
            item.querySelector('div[style="flex:1;"]').appendChild(delBtn);
          } else {
            delBtn.style.display = 'block';
          }

          updateDocProgress();
          await dbSaveDocStatus(currentEmail, docName, 'done', fileUrl);
          if (currentEmail) toast('✓ Sənəd uğurla bazaya yükləndi');
        });
      }

      if (!item.querySelector('.add-page-btn')) {
         const addBtn = document.createElement('button');
         addBtn.className = 'add-page-btn';
         addBtn.textContent = '+';
         addBtn.style.cssText = 'margin-left:8px; border:1px solid rgba(255,255,255,0.2); background:transparent; color:var(--cream); border-radius:4px; padding:4px 10px; cursor:pointer; font-size:16px;';
         addBtn.title = 'Yeni səhifə əlavə et';
         addBtn.onclick = () => {
             const newItem = item.cloneNode(true);
             newItem.dataset.status = 'pending';
             const newStamp = newItem.querySelector('.stamp');
             if(newStamp) { newStamp.className = 'stamp pending'; newStamp.innerHTML = '&#9675;'; }
             const newInp = newItem.querySelector('.doc-file');
             if(newInp) { newInp.value = ''; delete newInp.dataset.bound; }
             const newLbl = newItem.querySelector('.upload-btn');
             if(newLbl) { newLbl.style.display = ''; }
             const newDelBtn = newItem.querySelector('.doc-del-btn');
             if(newDelBtn) newDelBtn.remove();
             
             const nameEl = newItem.querySelector('.doc-name');
             let baseName = nameEl.textContent;
             let match = baseName.match(/(.*) \(səhifə (\d+)\)$/);
             let pageNum = 2;
             if(match) {
                 baseName = match[1];
                 pageNum = parseInt(match[2]) + 1;
             }
             nameEl.textContent = `${baseName} (səhifə ${pageNum})`;
             
             const dueEl = newItem.querySelector('.doc-due');
             if(dueEl && dueEl.dataset.default) dueEl.textContent = dueEl.dataset.default;
             
             const oldAddBtn = newItem.querySelector('.add-page-btn');
             if(oldAddBtn) oldAddBtn.remove();

             item.parentNode.insertBefore(newItem, item.nextSibling);
             bindDocItem(newItem);
         };
         
         const rightContainer = item.querySelector('.upload-btn');
         if (rightContainer) {
            rightContainer.parentNode.insertBefore(addBtn, rightContainer.nextSibling);
         } else {
            item.appendChild(addBtn);
         }
      }

      if (!item.querySelector('.remove-page-btn')) {
         const nameText = item.querySelector('.doc-name').textContent;
         if (/(.*) \(səhifə (\d+)\)$/.test(nameText)) {
             const rmBtn = document.createElement('button');
             rmBtn.className = 'remove-page-btn';
             rmBtn.innerHTML = '&times;';
             rmBtn.style.cssText = 'margin-left:4px; border:1px solid rgba(255,100,100,0.4); background:transparent; color:var(--coral); border-radius:4px; padding:4px 10px; cursor:pointer; font-size:16px;';
             rmBtn.title = 'Əlavə səhifəni sil';
             rmBtn.onclick = async () => {
                 if (!confirm('Bu səhifəni tamamilə silmək istədiyinizə əminsiniz?')) return;
                 const docName = item.querySelector('.doc-name').textContent;
                 item.remove();
                 updateDocProgress();
                 if (currentEmail && sb) {
                     await sb.from('document_status').delete().match({ profile_email: currentEmail, doc_name: docName });
                 }
             };
             
             const rightContainer = item.querySelector('.add-page-btn') || item.querySelector('.upload-btn');
             if (rightContainer) {
                rightContainer.parentNode.insertBefore(rmBtn, rightContainer.nextSibling);
             } else {
                item.appendChild(rmBtn);
             }
         }
      }
    }

    /* ═══════════════════════════════════════════════════════════
       SƏNƏD ŞABLONLARI (bazadan idarə olunur)
       ──────────────────────────────────────────────────────────
       Əvvəllər 11 sənəd və "Son tarix — 20 iyul" kimi tarixlər HTML-ə
       sabit yazılmışdı: hər il köhnəlirdi və ölkəyə görə dəyişmirdi.
       İndi `document_templates` cədvəlindən gəlir. Cədvəl yoxdursa və ya
       boşdursa aşağıdakı daxili siyahıya qayıdırıq ki, tətbiq işləməz
       vəziyyətə düşməsin.
    ═══════════════════════════════════════════════════════════ */
    const DEFAULT_DOC_TEMPLATES = [
      { doc_name: 'Diplom və qiymət cədvəli', due_date: null, country: null },
      { doc_name: 'Motivasiya məktubu', due_date: null, country: null },
      { doc_name: 'CV / Rezüme', due_date: null, country: null },
      { doc_name: 'Pasportun surəti', due_date: null, country: null },
      { doc_name: 'IELTS / TOEFL nəticəsi', due_date: null, country: null },
      { doc_name: 'Tövsiyə məktubu 1', due_date: null, country: null },
      { doc_name: 'Tövsiyə məktubu 2', due_date: null, country: null },
      { doc_name: 'Bank arayışı (maliyyə sənədi)', due_date: null, country: null },
      { doc_name: 'Tibbi sığorta sənədi', due_date: null, country: null },
      { doc_name: 'Vəsiqəlik foto', due_date: null, country: null },
      { doc_name: 'Doğum haqqında şəhadətnamə', due_date: null, country: null }
    ];

    let docTemplatesCache = null;

    function formatDueDate(value) {
      if (!value) return 'Son tarix qeyd olunmayıb';
      const d = new Date(value + 'T00:00:00');
      if (isNaN(d)) return 'Son tarix qeyd olunmayıb';
      const months = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun',
        'iyul', 'avqust', 'sentyabr', 'oktyabr', 'noyabr', 'dekabr'];
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const daysLeft = Math.round((d - today) / 86400000);
      let suffix = '';
      if (daysLeft < 0) suffix = ' · vaxtı keçib';
      else if (daysLeft === 0) suffix = ' · bu gün';
      else if (daysLeft <= 7) suffix = ` · ${daysLeft} gün qalıb`;
      return `Son tarix — ${d.getDate()} ${months[d.getMonth()]}${suffix}`;
    }

    async function fetchDocTemplates() {
      if (!sb) return DEFAULT_DOC_TEMPLATES;
      const { data, error } = await sb.from('document_templates')
        .select('*')
        .eq('active', true)
        .order('sort_order', { ascending: true })
        .order('id', { ascending: true });
      if (error) {
        console.warn('Sənəd şablonları yüklənmədi, daxili siyahı istifadə olunur:', error.message);
        return DEFAULT_DOC_TEMPLATES;
      }
      if (!data || !data.length) return DEFAULT_DOC_TEMPLATES;
      return data;
    }

    // Tələbənin seçdiyi ölkələrə uyğun sənədləri süz (country boşdursa hamıya aiddir)
    function filterTemplatesForStudent(templates) {
      return templates.filter(t => !t.country || selCountries.includes(t.country));
    }

    function docItemHtml(tpl) {
      const overdue = tpl.due_date && new Date(tpl.due_date + 'T00:00:00') < new Date(new Date().setHours(0, 0, 0, 0));
      return `
        <div class="doc-item" data-status="pending">
          <div class="stamp pending">&#9675;</div>
          <div style="flex:1;">
            <p class="doc-name">${escapeHtml(tpl.doc_name)}</p>
            <p class="doc-due"${overdue ? ' style="color:var(--coral);"' : ''}>${escapeHtml(formatDueDate(tpl.due_date))}</p>
          </div>
          <label class="upload-btn"><span class="upload-btn-label">${escapeHtml(t('upload', 'Yüklə'))}</span><input type="file" accept="image/*,.pdf,application/pdf" class="doc-file"></label>
        </div>`;
    }

    async function renderDocList() {
      const listEl = document.getElementById('doc-list');
      const emptyEl = document.getElementById('doc-list-empty');
      if (!listEl) return;

      if (!docTemplatesCache) docTemplatesCache = await fetchDocTemplates();
      const templates = filterTemplatesForStudent(docTemplatesCache);

      if (!templates.length) {
        listEl.innerHTML = '';
        listEl.style.display = 'none';
        if (emptyEl) emptyEl.style.display = 'block';
        updateDocProgress();
        return;
      }

      listEl.style.display = '';
      if (emptyEl) emptyEl.style.display = 'none';
      listEl.innerHTML = templates.map(docItemHtml).join('');
      listEl.querySelectorAll('.doc-item').forEach(item => bindDocItem(item));

      // Başlıq altındakı mətn tələbənin öz seçiminə uyğunlaşsın
      const sub = document.getElementById('docs-subtitle');
      if (sub) {
        sub.textContent = selUnis.length
          ? `${selUnis[0]} üzrə müraciət üçün sənədlər.`
          : 'Müraciətiniz üçün lazım olan sənədlər.';
      }
      updateDocProgress();
    }

    renderDocList();

    /* ═══════════════════════════════════════════════════════════
       KONSULTASİYA BOOKİNG
    ═══════════════════════════════════════════════════════════ */
    document.querySelectorAll('.book-toggle').forEach(btn => {
      btn.onclick = () => {
        const p = btn.nextElementSibling;
        p.style.display = p.style.display === 'none' ? 'block' : 'none';
      };
    });
    document.querySelectorAll('.book-confirm').forEach(btn => {
      btn.onclick = async () => {
        const panel = btn.closest('.book-panel');
        const typeEl = panel.querySelector('.book-type');
        const type = typeEl ? typeEl.value : 'Online';
        const date = panel.querySelector('.book-date').value;
        const time = panel.querySelector('.book-time').value;
        const msg = panel.querySelector('.book-confirmed');
        const advisorBase = btn.closest('.card').querySelector('.uni-name').textContent;
        const advisor = advisorBase + ' (' + type + ')';
        const showErr = (text) => {
          msg.style.display = 'block'; msg.style.color = 'var(--coral)'; msg.textContent = text;
        };

        if (!date || !time) { showErr('Zəhmət olmasa tarix və saat seç.'); return; }

        const selectedDate = new Date(date + 'T00:00:00');
        const tomorrow = new Date();
        tomorrow.setHours(0, 0, 0, 0);
        tomorrow.setDate(tomorrow.getDate() + 1);
        if (selectedDate < tomorrow) {
          showErr('Görüşü ən tez sabaha təyin edə bilərsiniz.'); return;
        }

        const slotError = validateBookingSlot(date, time);
        if (slotError) { showErr(slotError); return; }

        btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Yoxlanılır...';
        const taken = await isSlotTaken(advisorBase, date, time);
        if (taken) {
          btn.disabled = false; btn.innerHTML = 'Görüşü təsdiqlə';
          msg.style.display = 'block'; msg.style.color = 'var(--coral)';
          msg.textContent = 'Bu tarix və saat üçün artıq başqa görüş var. Zəhmət olmasa başqa saat və ya gün seçin.';
          return;
        }

        btn.innerHTML = '<span class="spinner"></span>Saxlanılır...';
        const { error } = await dbSaveConsultation(currentEmail, advisor, date, time);
        btn.disabled = false; btn.innerHTML = 'Görüşü təsdiqlə';
        if (error) { msg.style.display = 'block'; msg.style.color = 'var(--coral)'; msg.textContent = 'Xəta baş verdi.'; return; }
        msg.style.display = 'block'; msg.style.color = 'var(--teal)';
        msg.textContent = 'Görüş planlaşdırıldı: ' + date + ', saat ' + time + ' (' + type + ').';
        if (currentEmail) toast('✓ Görüş Supabase-ə saxlanıldı!');
        loadMyConsultations();
      };
    });

    /* ── Görüş vaxtı qaydaları ──────────────────────────────────
       Əvvəllər tələbə istənilən saatı (məs. gecə 03:00) və istənilən günü
       seçə bilirdi. İndi yalnız iş saatları, tam saat başı və iş günləri. */
    const BOOKING_RULES = {
      startHour: 10,     // 10:00-dan
      endHour: 18,       // 18:00-a qədər (18:00 son başlanğıc deyil — aşağıya bax)
      lastStartHour: 17, // son görüş 17:00-da başlayır (1 saat davam edir)
      slotMinutes: 60,
      closedWeekdays: [0] // 0 = bazar günü bağlıdır
    };

    function validateBookingSlot(dateStr, timeStr) {
      const d = new Date(dateStr + 'T00:00:00');
      if (BOOKING_RULES.closedWeekdays.includes(d.getDay())) {
        return 'Bazar günü görüş keçirilmir. Zəhmət olmasa başqa gün seçin.';
      }
      const [hStr, mStr] = (timeStr || '').split(':');
      const h = parseInt(hStr, 10), m = parseInt(mStr, 10);
      if (isNaN(h) || isNaN(m)) return 'Saat düzgün seçilməyib.';
      if (m !== 0) {
        return `Görüşlər tam saat başı olur (məs. ${String(BOOKING_RULES.startHour).padStart(2, '0')}:00, 11:00, 12:00).`;
      }
      if (h < BOOKING_RULES.startHour || h > BOOKING_RULES.lastStartHour) {
        return `İş saatları: ${String(BOOKING_RULES.startHour).padStart(2, '0')}:00 – ${BOOKING_RULES.endHour}:00. Son görüş ${BOOKING_RULES.lastStartHour}:00-da başlayır.`;
      }
      return null;
    }

    // Tarix sahələri: ən tez sabah
    const minTomorrow = new Date();
    minTomorrow.setDate(minTomorrow.getDate() + 1);
    const yyyy = minTomorrow.getFullYear();
    const mm = String(minTomorrow.getMonth() + 1).padStart(2, '0');
    const dd = String(minTomorrow.getDate()).padStart(2, '0');
    const minDateStr = `${yyyy}-${mm}-${dd}`;
    document.querySelectorAll('.book-date').forEach(inp => inp.min = minDateStr);

    // Saat sahələri: iş saatları aralığı + saat başı addım
    document.querySelectorAll('.book-time').forEach(inp => {
      inp.min = String(BOOKING_RULES.startHour).padStart(2, '0') + ':00';
      inp.max = String(BOOKING_RULES.lastStartHour).padStart(2, '0') + ':00';
      inp.step = BOOKING_RULES.slotMinutes * 60;
    });

    // Hər bron panelinin altına iş saatları qeydi
    document.querySelectorAll('.book-panel').forEach(panel => {
      if (panel.querySelector('.booking-hint')) return;
      const hint = document.createElement('p');
      hint.className = 'booking-hint doc-due';
      hint.style.cssText = 'margin:-8px 0 10px;';
      hint.textContent = `İş saatları: ${String(BOOKING_RULES.startHour).padStart(2, '0')}:00–${BOOKING_RULES.endHour}:00, saat başı. Bazar günü bağlıdır.`;
      const timeField = panel.querySelector('.book-time')?.closest('.field');
      if (timeField) timeField.insertAdjacentElement('afterend', hint);
    });

    /* ═══════════════════════════════════════════════════════════
       UNİVERSİTETLƏR KATALOQU (onboarding DATA ilə eyni mənbədən)
    ═══════════════════════════════════════════════════════════ */

    // Ölkənin təxmini xərc səviyyəsi (0=aşağı, 1=orta, 2=yüksək) — real təhsil haqqı
    // məlumatı olmadığı üçün büdcə uyğunluğunu təxmini qiymətləndirmək məqsədilə.
    const COUNTRY_COST_TIER = {
      "Almaniya": 0, "Norveç": 0, "Finlandiya": 0, "Avstriya": 0, "Çexiya": 0, "Polşa": 0,
      "Estoniya": 0, "Qazaxıstan": 0, "Özbəkistan": 0, "Türkiyə": 0,
      "İsveç": 1, "İtaliya": 1, "Fransa": 1, "Niderland": 1, "İspaniya": 1, "Danimarka": 1,
      "Yaponiya": 1, "Cənubi Koreya": 1,
      "Böyük Britaniya": 2, "ABŞ": 2, "İsveçrə": 2, "Kanada": 2
    };
    const BUDGET_INDEX = {
      '3 000 €-dan az': 0, '3 000 – 7 000 €': 1, '7 000 – 15 000 €': 2, '15 000 €-dan çox': 3
    };

    // Büdcə seçimində "Digər (özün yaz)" seçilibsə əl ilə yazılan mətni, əks halda
    // seçilmiş aralığın mətnini qaytarır — profilə saxlanılan yeganə "həqiqi" dəyər budur.
    function getBudgetValue() {
      const sel = document.getElementById('f-budget');
      if (!sel) return '';
      if (sel.value === 'other') return document.getElementById('f-budget-custom')?.value.trim() || '';
      return sel.value;
    }
    // Saxlanmış (bazadan gələn və ya qaralamadan bərpa olunan) büdcə mətnini formaya qoyur —
    // sabit aralıqlardan biridirsə seçir, deyilsə "Digər" seçib əl ilə yazılan xanaya yazır.
    function setBudgetValue(val) {
      const sel = document.getElementById('f-budget');
      const custom = document.getElementById('f-budget-custom');
      if (!sel || !val) return;
      const isFixedOption = Array.from(sel.options).some(o => o.value === val && o.value !== 'other');
      if (isFixedOption) {
        sel.value = val;
        if (custom) custom.style.display = 'none';
      } else {
        sel.value = 'other';
        if (custom) { custom.value = val; custom.style.display = 'block'; }
      }
    }
    document.getElementById('f-budget')?.addEventListener('change', () => {
      const custom = document.getElementById('f-budget-custom');
      if (custom) custom.style.display = document.getElementById('f-budget').value === 'other' ? 'block' : 'none';
    });

    // Profilə (seçilmiş ölkə/ixtisas/büdcə/imtahan) əsasən TƏXMİNİ uyğunluq balı.
    // Real qəbul şərtləri bazada olmadığı üçün bu, göz qabağında olan meyarlara
    // görə şəffaf çəkilərlə hesablanan bir istiqamətləndirmədir, rəsmi qəbul zəmanəti deyil.
    function calculateMatchBreakdown(country) {
      let countryScore = 55;
      if (selCountries.length) countryScore = selCountries.includes(country) ? 100 : 35;

      const tier = COUNTRY_COST_TIER[country] ?? 1;
      const budgetVal = getBudgetValue();
      let budgetScore = 70;
      if (budgetVal && budgetVal in BUDGET_INDEX) {
        const idx = BUDGET_INDEX[budgetVal];
        budgetScore = idx >= tier ? 100 : Math.max(25, 100 - (tier - idx) * 30);
      }

      let fieldScore = 70;
      if (selFields.length) fieldScore = selFields.some(f => DEPTS.includes(f)) ? 100 : 45;

      const selectedExams = Array.from(document.querySelectorAll('#f-exams .chip.sel')).map(c => c.textContent);
      const examScore = (selectedExams.length && !selectedExams.includes('Hələ yoxdur')) ? 90 : 55;

      const total = Math.round(countryScore * 0.35 + budgetScore * 0.30 + fieldScore * 0.20 + examScore * 0.15);
      return { country: countryScore, budget: budgetScore, field: fieldScore, exam: examScore, total };
    }
    function calculateMatchScore(country) {
      return calculateMatchBreakdown(country).total;
    }
    const COST_TIER_LABEL = { 0: 'Aşağı', 1: 'Orta', 2: 'Yüksək' };

    let uniFilterCountry = 'all';
    let uniSearchQuery = '';

    function renderUniFilters() {
      const c = document.getElementById('uni-filters');
      if (!c) return;
      c.innerHTML = '';
      if (selCountries.length) {
        const mineChip = document.createElement('div');
        mineChip.className = 'chip' + (uniFilterCountry === 'mine' ? ' sel' : '');
        mineChip.textContent = t('uni_filter_mine', 'Mənim ölkələrim');
        mineChip.onclick = () => { uniFilterCountry = 'mine'; renderUniFilters(); renderUniCatalog(); };
        c.appendChild(mineChip);
      }
      const allChip = document.createElement('div');
      allChip.className = 'chip' + (uniFilterCountry === 'all' ? ' sel' : '');
      allChip.textContent = t('all_countries', 'Hamısı');
      allChip.onclick = () => { uniFilterCountry = 'all'; renderUniFilters(); renderUniCatalog(); };
      c.appendChild(allChip);
      Object.keys(DATA).forEach(country => {
        const ch = document.createElement('div');
        ch.className = 'chip' + (uniFilterCountry === country ? ' sel' : '');
        ch.textContent = country;
        ch.onclick = () => { uniFilterCountry = country; renderUniFilters(); renderUniCatalog(); };
        c.appendChild(ch);
      });
    }

    function renderUniCatalog() {
      const listEl = document.getElementById('uni-list');
      const emptyEl = document.getElementById('uni-list-empty');
      if (!listEl) return;

      // Qeyd: f-budget həmişə (toxunulmasa belə) ilk seçimin dəyərini daşıyır, ona görə
      // profilin doldurulub-doldurulmadığını yalnız ölkə/ixtisas seçimlərinə görə müəyyən edirik.
      const hasProfile = !!(selCountries.length || selFields.length);

      let entries = [];
      Object.keys(DATA).forEach(country => {
        if (uniFilterCountry === 'mine') { if (!selCountries.includes(country)) return; }
        else if (uniFilterCountry !== 'all' && country !== uniFilterCountry) return;
        Object.keys(DATA[country]).forEach(uniName => {
          if (uniSearchQuery && !uniName.toLowerCase().includes(uniSearchQuery) && !country.toLowerCase().includes(uniSearchQuery)) return;
          entries.push({ country, name: uniName });
        });
      });

      if (hasProfile) {
        entries.forEach(e => e.score = calculateMatchScore(e.country));
        entries.sort((a, b) => b.score - a.score);
      }

      if (!entries.length) {
        listEl.innerHTML = '';
        if (emptyEl) emptyEl.style.display = 'block';
        return;
      }
      if (emptyEl) emptyEl.style.display = 'none';

      const LIMIT = 60;
      const shown = entries.slice(0, LIMIT);

      listEl.innerHTML = shown.map(e => {
        const isSelected = selUnis.includes(e.name);
        const isComparing = compareList.includes(e.name);
        const deptCount = DATA[e.country][e.name].length;
        return `
      <div class="card uni-card" data-uni="${e.name}" style="cursor:pointer;">
        <div class="uni-row">
          <div>
            <p class="uni-name">${e.name}</p>
            <p class="uni-loc">${e.country} · ${deptCount} ixtisas mövcuddur</p>
          </div>
          ${hasProfile ? `<div class="match">${e.score}% uyğun</div>` : ''}
        </div>
        <div class="uni-tags"><span class="tag" style="${isSelected ? 'background:var(--navy); color:var(--gold);' : ''}">${isSelected ? '✓ Seçilib' : 'Seçmək üçün toxun'}</span></div>
        <div class="compare-check${isComparing ? ' sel' : ''}" data-compare-uni="${e.name}">
          <span class="box">${isComparing ? '✓' : ''}</span>
          <span>Müqayisəyə əlavə et</span>
        </div>
      </div>`;
      }).join('');

      if (entries.length > LIMIT) {
        const more = document.createElement('p');
        more.className = 'doc-due';
        more.style.cssText = 'text-align:center; padding:10px 0;';
        more.textContent = `+ ${entries.length - LIMIT} universitet də var — axtarış və ya ölkə filtri ilə daraldın.`;
        listEl.appendChild(more);
      }

      listEl.querySelectorAll('.uni-card').forEach(card => {
        card.addEventListener('click', () => toggleUniSelection(card.dataset.uni));
      });
      listEl.querySelectorAll('.compare-check').forEach(chk => {
        chk.addEventListener('click', (e) => {
          e.stopPropagation();
          toggleCompare(chk.dataset.compareUni);
        });
      });
    }

    /* ═══════════════════════════════════════════════════════════
       UNİVERSİTET MÜQAYİSƏSİ (2-3 universitet yan-yana)
    ═══════════════════════════════════════════════════════════ */
    let compareList = [];

    function toggleCompare(uniName) {
      if (compareList.includes(uniName)) {
        compareList = compareList.filter(u => u !== uniName);
      } else {
        if (compareList.length >= 3) { toast('Ən çoxu 3 universiteti müqayisə edə bilərsiniz', true); return; }
        compareList.push(uniName);
      }
      renderCompareBar();
      renderUniCatalog();
    }

    function renderCompareBar() {
      const bar = document.getElementById('compare-bar');
      const countEl = document.getElementById('compare-bar-count');
      const goBtn = document.getElementById('compare-go-btn');
      if (!bar) return;
      countEl.textContent = compareList.length;
      goBtn.disabled = compareList.length < 2;
      goBtn.style.opacity = compareList.length < 2 ? '.5' : '1';
      bar.classList.toggle('show', compareList.length > 0);
    }

    function findUniCountry(uniName) {
      return Object.keys(DATA).find(co => DATA[co] && DATA[co][uniName]) || null;
    }

    function renderComparisonScreen() {
      const table = document.getElementById('compare-table');
      const sub = document.getElementById('compare-sub');
      if (!table) return;

      const hasProfile = !!(selCountries.length || selFields.length);
      sub.textContent = hasProfile
        ? 'Seçdiyin universitetlər yan-yana — uyğunluq profilinə görə hesablanıb.'
        : 'Seçdiyin universitetlər yan-yana. Uyğunluq faizini görmək üçün profilini doldur.';

      const unis = compareList.map(name => {
        const country = findUniCountry(name) || 'İstifadəçi seçimi';
        const breakdown = hasProfile ? calculateMatchBreakdown(country) : null;
        return { name, country, breakdown };
      });

      let rows = '';
      rows += `<tr><th>Universitet</th>${unis.map(u => `<th>${u.name}</th>`).join('')}</tr>`;

      const dataRow = (label, fn) => `<tr><td>${label}</td>${unis.map(fn).join('')}</tr>`;

      let body = '';
      body += dataRow('Ölkə', u => `<td>${u.country}</td>`);
      body += dataRow('Xərc səviyyəsi', u => `<td>${COST_TIER_LABEL[COUNTRY_COST_TIER[u.country] ?? 1]}</td>`);
      body += dataRow('Mövcud ixtisas', u => `<td>${DATA[u.country] && DATA[u.country][u.name] ? DATA[u.country][u.name].length : '—'}</td>`);
      body += dataRow('Profilinizdə seçilib?', u => `<td>${selUnis.includes(u.name) ? '✓' : '—'}</td>`);

      if (hasProfile) {
        body += dataRow('Ümumi uyğunluq', u => `<td><b style="color:var(--teal);">${u.breakdown.total}%</b></td>`);
        body += dataRow('— Ölkə uyğunluğu', u => `<td>${u.breakdown.country}%</td>`);
        body += dataRow('— Büdcə uyğunluğu', u => `<td>${u.breakdown.budget}%</td>`);
        body += dataRow('— İxtisas uyğunluğu', u => `<td>${u.breakdown.field}%</td>`);
        body += dataRow('— İmtahan hazırlığı', u => `<td>${u.breakdown.exam}%</td>`);
      }

      body += `<tr><td>&nbsp;</td>${unis.map(u => `
        <td>
          <button class="compare-remove-btn" data-remove-uni="${u.name}">Çıxar</button>
        </td>`).join('')}</tr>`;

      table.innerHTML = `<thead>${rows}</thead><tbody>${body}</tbody>`;

      table.querySelectorAll('[data-remove-uni]').forEach(btn => {
        btn.addEventListener('click', () => {
          compareList = compareList.filter(u => u !== btn.dataset.removeUni);
          renderCompareBar();
          renderUniCatalog();
          if (compareList.length < 2) { showScreen('unis'); return; }
          renderComparisonScreen();
        });
      });
    }

    document.getElementById('compare-clear-btn')?.addEventListener('click', () => {
      compareList = [];
      renderCompareBar();
      renderUniCatalog();
    });
    document.getElementById('compare-go-btn')?.addEventListener('click', () => {
      if (compareList.length < 2) return;
      renderComparisonScreen();
      showScreen('uni-compare');
    });
    document.getElementById('compare-back-btn')?.addEventListener('click', () => showScreen('unis'));

    async function toggleUniSelection(uniName) {
      if (selUnis.includes(uniName)) {
        selUnis = selUnis.filter(u => u !== uniName);
        toast(`"${uniName}" seçimdən çıxarıldı`);
      } else {
        if (selUnis.length >= 5) { toast('Maksimum 5 universitet seçə bilərsiniz', true); return; }
        selUnis.push(uniName);
        toast(`"${uniName}" seçimlərə əlavə edildi`);
      }
      renderUniCatalog();
      if (typeof syncHomeSummary === 'function') syncHomeSummary();
      if (currentEmail && sb) await dbSaveProfile({ email: currentEmail, target_universities: selUnis });
    }

    document.getElementById('uni-search')?.addEventListener('input', (e) => {
      uniSearchQuery = e.target.value.trim().toLowerCase();
      renderUniCatalog();
    });

    renderUniFilters();
    renderUniCatalog();

    /* ═══════════════════════════════════════════════════════════
       FORM — RADIO / CHİP
    ═══════════════════════════════════════════════════════════ */
    document.querySelectorAll('#f-level .radio-opt').forEach(o => {
      o.onclick = () => { document.querySelectorAll('#f-level .radio-opt').forEach(x => x.classList.remove('sel')); o.classList.add('sel'); };
    });
    document.querySelectorAll('#f-exams .chip').forEach(ch => {
      ch.onclick = () => {
        ch.classList.toggle('sel');
        // Mövcud balları itirməmək üçün əvvəlcə oxuyub sonra yenidən qururuq
        const existingValues = {};
        document.querySelectorAll('.dyn-score-input').forEach(inp => existingValues[inp.dataset.exam] = inp.value);
        rebuildScoreInputs(existingValues);
      };
    });

    /* ═══════════════════════════════════════════════════════════
       ONBOARDING — QARALAMA (avtosaxlama) VƏ İRƏLİLƏYİŞ
       ──────────────────────────────────────────────────────────
       Forma uzundur; əvvəllər yarımçıq qoyulanda hər şey itirdi.
       İndi cihazda saxlanılır və növbəti açılışda bərpa olunur.
    ═══════════════════════════════════════════════════════════ */
    function onbDraftKey() {
      return `btm_onboarding_draft_${currentEmail || 'anon'}`;
    }

    function collectOnboardingState() {
      const scores = {};
      document.querySelectorAll('.dyn-score-input').forEach(inp => { scores[inp.dataset.exam] = inp.value; });
      return {
        name: document.getElementById('f-name')?.value || '',
        fatherName: document.getElementById('f-father-name')?.value || '',
        email: document.getElementById('f-email')?.value || '',
        phone: document.getElementById('f-phone')?.value || '',
        budget: getBudgetValue(),
        level: document.querySelector('#f-level .radio-opt.sel')?.dataset.value || '',
        exams: Array.from(document.querySelectorAll('#f-exams .chip.sel')).map(c => c.textContent),
        countries: selCountries, fields: selFields,
        scores
      };
    }

    function updateOnboardingProgress() {
      const s = collectOnboardingState();
      // 7 əsas addım — hər biri bərabər çəkidə (universitet seçimi formdan çıxarılıb,
      // profil tamamlandıqdan sonra ayrıca "Universitetlər" ekranında edilir)
      const steps = [
        !!s.name.trim(), !!s.email.trim(), !!s.phone.trim(),
        s.countries.length > 0,
        s.fields.length > 0, !!s.level, s.exams.length > 0
      ];
      const done = steps.filter(Boolean).length;
      const pct = Math.round(done / steps.length * 100);
      const fill = document.getElementById('onb-progress-fill');
      const label = document.getElementById('onb-progress-pct');
      if (fill) fill.style.width = pct + '%';
      if (label) label.textContent = pct + '%';
    }

    let onbSaveTimer = null;
    function saveOnboardingDraft() {
      updateOnboardingProgress();
      clearTimeout(onbSaveTimer);
      onbSaveTimer = setTimeout(() => {
        try {
          localStorage.setItem(onbDraftKey(), JSON.stringify(collectOnboardingState()));
          const note = document.getElementById('onb-draft-note');
          if (note) note.style.display = 'block';
        } catch (e) { /* localStorage yoxdursa səssizcə keç */ }
      }, 500);
    }

    function clearOnboardingDraft() {
      try { localStorage.removeItem(onbDraftKey()); } catch (e) { }
      const note = document.getElementById('onb-draft-note');
      if (note) note.style.display = 'none';
    }

    function restoreOnboardingDraft() {
      let s = null;
      try { s = JSON.parse(localStorage.getItem(onbDraftKey()) || 'null'); } catch (e) { }
      if (!s) { updateOnboardingProgress(); return; }

      const set = (id, val) => { const el = document.getElementById(id); if (el && val) el.value = val; };
      set('f-name', s.name); set('f-father-name', s.fatherName); set('f-email', s.email); set('f-phone', s.phone);
      if (s.budget) setBudgetValue(s.budget);

      if (Array.isArray(s.countries)) selCountries = s.countries;
      if (Array.isArray(s.fields)) selFields = s.fields;

      if (s.level) {
        document.querySelectorAll('#f-level .radio-opt').forEach(o => {
          o.classList.toggle('sel', o.dataset.value === s.level);
        });
      }
      if (Array.isArray(s.exams) && s.exams.length) {
        document.querySelectorAll('#f-exams .chip').forEach(ch => {
          ch.classList.toggle('sel', s.exams.includes(ch.textContent));
        });
        rebuildScoreInputs(s.scores || {});
      }

      renderCountryChips(); renderFieldChips();
      const note = document.getElementById('onb-draft-note');
      if (note) note.style.display = 'block';
      updateOnboardingProgress();
    }

    // İmtahan bal xanalarını yenidən qurur (qaralama bərpası və seçim dəyişikliyi üçün)
    function rebuildScoreInputs(existingValues = {}) {
      const container = document.getElementById('dynamic-scores-container');
      if (!container) return;
      const selectedExams = Array.from(document.querySelectorAll('#f-exams .chip.sel')).map(c => c.textContent);
      if (selectedExams.includes('Hələ yoxdur') || !selectedExams.length) { container.innerHTML = ''; return; }

      container.innerHTML = selectedExams.map(exam => {
        if (exam === 'Hələ yoxdur') return '';
        const label = exam === 'Digər sertifikat'
          ? 'Digər sertifikatın adı və balı'
          : `${escapeHtml(exam)} balınızı daxil edin`;
        const ph = exam === 'Digər sertifikat' ? 'məs. TYS 75' : 'məs. 80';
        return `<div class="field"><label>${label}</label><input type="text" class="dyn-score-input" data-exam="${escapeHtml(exam)}" placeholder="${ph}"></div>`;
      }).join('');

      container.querySelectorAll('.dyn-score-input').forEach(inp => {
        if (existingValues[inp.dataset.exam]) inp.value = existingValues[inp.dataset.exam];
        inp.addEventListener('input', saveOnboardingDraft);
      });
    }

    // Bütün onboarding sahələrini avtosaxlamaya bağla
    ['f-name', 'f-father-name', 'f-email', 'f-phone', 'f-budget', 'f-budget-custom'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.addEventListener('input', saveOnboardingDraft); el.addEventListener('change', saveOnboardingDraft); }
    });
    document.querySelectorAll('#f-level .radio-opt').forEach(o => o.addEventListener('click', saveOnboardingDraft));
    document.querySelectorAll('#f-exams .chip').forEach(ch => ch.addEventListener('click', saveOnboardingDraft));

    /* ═══════════════════════════════════════════════════════════
       ONBOARDING SUBMIT → SUPABASE
    ═══════════════════════════════════════════════════════════ */
    document.getElementById('submit-onboarding').addEventListener('click', async () => {
      const name = document.getElementById('f-name').value.trim() || 'Tələbə';
      const fatherName = document.getElementById('f-father-name').value.trim();
      const email = document.getElementById('f-email').value.trim();
      const phone = document.getElementById('f-phone').value.trim();
      const level = document.querySelector('#f-level .radio-opt.sel').dataset.value;

      const dynInputs = document.querySelectorAll('.dyn-score-input');
      let scoreArr = [];
      dynInputs.forEach(inp => { if (inp.value.trim()) scoreArr.push(`${inp.dataset.exam}: ${inp.value.trim()}`); });
      const score = scoreArr.length ? scoreArr.join(', ') : 'qeyd olunmayıb';
      const budget = getBudgetValue();
      const exams = Array.from(document.querySelectorAll('#f-exams .chip.sel')).map(c => c.textContent);
      const examsText = exams.length ? exams.join(', ') : 'seçilməyib';
      const countryText = selCountries.length ? selCountries.join(', ') : 'seçilməyib';
      const uniText = selUnis.length ? selUnis.join(', ') : 'seçilməyib';
      const fieldText = selFields.length ? selFields.join(', ') : 'seçilməyib';

      // Nəticə ekranını doldur
      document.getElementById('result-name-title').textContent = 'Təşəkkürlər, ' + name.split(' ')[0];
      ['r-name', 'r-email', 'r-phone', 'r-country', 'r-university', 'r-field', 'r-level', 'r-exams', 'r-score', 'r-budget']
        .forEach((id, i) => {
          document.getElementById(id).textContent = [name, email || 'qeyd olunmayıb', phone || 'qeyd olunmayıb',
            countryText, uniText, fieldText, level, examsText, score, budget][i];
        });

      const fatherRow = document.getElementById('r-father-name-row');
      if (fatherName) {
        document.getElementById('r-father-name').textContent = fatherName;
        fatherRow.style.display = 'flex';
      } else {
        fatherRow.style.display = 'none';
      }

      const noEl = document.getElementById('r-note');
      noEl.innerHTML = (!exams.length || exams.includes('Hələ yoxdur'))
        ? '<p class="uni-name" style="margin-bottom:4px;">İmtahana hazırlıq lazımdır</p><p class="uni-loc">Hələ imtahan nəticən yoxdursa, məsləhətçi sənə uyğun imtahan və hazırlıq müddətini müəyyən etməyə kömək edəcək.</p>'
        : '<p class="uni-name" style="margin-bottom:4px;">Universitet siyahısı hazırlanır</p><p class="uni-loc">Mövcud nəticələrinlə seçdiyin ölkə üzrə uyğun universitetlər "Universitet" bölməsində yenilənəcək.</p>';

      // Profil ekranını yenilə
      document.getElementById('home-greeting').textContent = 'Salam, ' + name.split(' ')[0];
      document.getElementById('profile-name-display').textContent = name;
      document.getElementById('profile-email-display').textContent = email || '—';
      document.getElementById('profile-level').textContent = level;
      document.getElementById('profile-field').textContent = fieldText;
      document.getElementById('profile-budget').textContent = budget;
      document.getElementById('profile-score').textContent = score;
      document.getElementById('profile-countries').textContent = countryText;
      const initials = (name.split(' ').map(w => w[0] || '').join('').slice(0, 2) || '?').toUpperCase();
      document.getElementById('profile-avatar-initials').textContent = initials;

      syncHomeSummary();

      showScreen('onboarding-result');

      // Supabase-ə saxla
      const btn = document.getElementById('submit-onboarding');
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Saxlanılır...';
      const { data, error } = await dbSaveProfile({
        name, father_name: fatherName || null, email, phone,
        target_countries: selCountries,
        target_universities: selUnis,
        fields: selFields,
        level, exams, score, budget
      });
      btn.disabled = false; btn.textContent = 'Profili tamamla';

      if (error) { toast('⚠️ Xəta: ' + error.message, true); }
      else {
        if (email) { currentEmail = email; }
        // Profil bazaya düşdü — qaralamaya ehtiyac qalmadı
        clearOnboardingDraft();
        toast('✓ Profil uğurla saxlanıldı!');
      }
    });

    /* ═══════════════════════════════════════════════════════════
       KONSULTASİYAYA KEÇ
    ═══════════════════════════════════════════════════════════ */
    document.getElementById('go-consult-from-result').addEventListener('click', () => {
      navBtns.forEach(b => b.classList.remove('active'));
      document.querySelector('[data-target="consult"]').classList.add('active');
      showScreen('consult');
    });

    /* ═══════════════════════════════════════════════════════════
       PROFİLDƏN SONRA UNİVERSİTET SEÇİMİNƏ KEÇ
       Universitet seçimi formdan çıxarılıb — profil tamamlanan kimi
       bu düymə tələbəni birbaşa öz seçdiyi ölkə(lər)ə görə süzülmüş
       kataloqa aparır.
    ═══════════════════════════════════════════════════════════ */
    document.getElementById('go-unis-from-result')?.addEventListener('click', () => {
      uniFilterCountry = selCountries.length ? 'mine' : 'all';
      renderUniFilters();
      renderUniCatalog();
      navBtns.forEach(b => b.classList.remove('active'));
      document.querySelector('[data-target="unis"]')?.classList.add('active');
      showScreen('unis');
    });

    /* ═══════════════════════════════════════════════════════════
       REAL-TIME SAAT
    ═══════════════════════════════════════════════════════════ */
    (function tick() {
      const now = new Date();
      document.getElementById('status-time').textContent =
        String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
      setTimeout(tick, 30000);
    })();

    /* ═══════════════════════════════════════════════════════════
       DİL DƏYİŞMƏ SİSTEMİ (i18n)
    ═══════════════════════════════════════════════════════════ */
    const translations = {
      az: {
        page_title: 'BTM - Xaricdə Təhsil',
        years_with_you: '20 ildir sizinlə',
        // Splash
        splash_tag: 'Xaricdə təhsil marşrutun — universitet seçimindən viza sənədlərinə qədər bir yerdə.',
        splash_start: 'Başla',
        uni_search_ph: '🔍 Universitet axtar...',
        // Auth
        login: 'Giriş',
        login_sub: 'Hesabınıza daxil olun',
        lbl_email: 'E-poçt ünvanı',
        lbl_password: 'Şifrə',
        btn_login: 'Daxil ol',
        forgot_password: 'Şifrəni unutmusunuz?',
        no_account: 'Hesabınız yoxdur?',
        register: 'Qeydiyyat',
        register_sub: 'Yeni hesab yaradın',
        lbl_fullname: 'Ad və Soyad',
        lbl_father_name: 'Ata adı',
        register_btn: 'Qeydiyyatdan keç',
        have_account: 'Artıq hesabınız var?',
        fp_title: 'Şifrəni bərpa et',
        fp_sub: 'E-poçt ünvanınızı daxil edin, sizə bərpa linki göndərək.',
        fp_send: 'Bağlantı göndər',
        fp_back: '← Girişə qayıt',
        login_locked_tpl: 'Çox sınaq oldu — {mins} dəqiqə sonra yenidən cəhd edin.',
        rp_title: 'Yeni şifrə təyin et',
        rp_sub: 'Hesabınız üçün yeni şifrə daxil edin.',
        lbl_new_password: 'Yeni şifrə',
        lbl_confirm_password: 'Yeni şifrəni təkrarla',
        rp_update: 'Şifrəni yenilə',
        // Home
        welcome: 'Xoş gördük',
        greeting: 'Salam, Tələbə',
        home_sub: 'Təhsil səyahətin Bilik ilə başlayır.',
        srv_dim: 'Qəbul hazırlığı',
        srv_yos: 'İmtahan hazırlığı',
        srv_abroad: 'Xaricdə',
        srv_abroad_sub: 'Təhsil & viza',
        srv_math: 'Riyaziyyat',
        srv_math_sub: '& Olimpiada',
        srv_higher_math: 'Ali Riyaziyyat',
        srv_higher_math_sub: '& Fizika',
        home_card_partners_title: 'Əməkdaşlar',
        home_card_partners_sub: 'Universitetlər',
        home_card_services_title: 'Xidmətlər',
        home_card_services_sub: 'Qiymətlə',
        home_card_achieve_title: 'Nailiyyətlər',
        home_card_achieve_sub: 'Uğurlarımız',
        home_card_team_title: 'Komanda',
        home_card_team_sub: 'Müəllimlər',
        home_card_news_title: 'Xəbərlər',
        home_card_news_sub: 'Elanlar',
        home_card_trialexams_title: 'Sınaqlar',
        home_card_trialexams_sub: 'Ödənişli',
        trialexams_title: 'Ödənişli Sınaq İmtahanları',
        trialexams_empty: 'Hələ sınaq imtahanı əlavə olunmayıb.',
        trialexams_register: 'Qeydiyyatdan keç',
        trialexams_paid: 'Ödənilib',
        trialexams_pending: 'Gözlənilir',
        trialexams_cancel: 'Ləğv et',
        trialexams_registered_toast: 'Qeydiyyatdan keçdiniz',
        trialexams_cancelled_toast: 'Ləğv edildi',
        trialexams_cancel_confirm: 'Qeydiyyatı ləğv etmək istədiyinizə əminsiniz?',
        trialexams_start: 'Sınağa başla',
        trialexams_exit: 'Çıx',
        trialexams_prev: 'Geri',
        trialexams_next: 'İrəli',
        trialexams_submit: 'Təqdim et',
        trialexams_no_questions_title: 'Suallar hazır deyil',
        trialexams_no_questions_sub: 'Bu sınaq üçün hələ sual əlavə olunmayıb. Mərkəzlə əlaqə saxlayın.',
        trialexams_not_eligible_title: 'Bu sınağa hələ girişiniz yoxdur',
        trialexams_not_eligible_sub: 'Ödəniş təsdiqləndikdən sonra sınağa başlaya biləcəksiniz.',
        trialexams_already_taken_title: 'Bu sınağı artıq vermisiniz',
        trialexams_already_taken_sub: 'Nəticənizi "Sınaqlar" bölməsində görə bilərsiniz.',
        trialexams_error_title: 'Xəta baş verdi',
        trialexams_error_sub: 'Bir az sonra yenidən cəhd edin.',
        trialexams_submit_confirm: 'Sınağı təqdim etdikdən sonra sualları yenidən görə bilməyəcəksiniz. Əminsiniz?',
        trialexams_submit_confirm_unanswered: '{n} suala cavab verməmisiniz. Yenə də təqdim etmək istəyirsiniz?',
        notif_trialexam_paid_title: 'Sınaq ödənişiniz təsdiqləndi',
        notif_trialexam_pending_title: 'Sınaq qeydiyyatınız qəbul edildi',
        notif_trialexam_result_title: 'Sınaq nəticəniz hazırdır',
        trialexams_correct_short: 'doğru',
        trialexams_wrong_short: 'səhv',
        stat_unis: 'Seçilmiş universitet',
        stat_docs: 'Tamamlanmış sənəd',
        stat_consults: 'Planlaşan konsultasiya',
        complete_profile: 'Profilini tamamla',
        complete_profile_sub: 'Ölkə, ixtisas, imtahan nəticələri və büdcəni doldur ki, sənə uyğun proqramları görək.',
        fill_form: 'Formu doldur',
        selected_unis: 'Seçdiyiniz universitetlər',
        about_us: 'Haqqımızda',
        // Universities
        unis_eyebrow: 'Axtarış',
        unis_title: 'Universitetlər',
        unis_sub: 'Bütün ölkə və ixtisaslar profilindəki eyni siyahıdandır — uyğunluq sənin profilinə görə hesablanır.',
        uni_empty: 'Bu axtarışa uyğun universitet tapılmadı.',
        all_countries: 'Hamısı',
        uni_filter_mine: 'Mənim ölkələrim',
        pick_unis_title: 'Universitet seçimini et',
        pick_unis_sub: 'Seçdiyin ölkə(lər)dəki bütün universitetlərə bax və özünə uyğun olanları seç.',
        pick_unis_btn: 'Universitetlərə bax',
        // Compare
        cmp_back: '← Universitetlərə qayıt',
        cmp_eyebrow: 'Müqayisə',
        cmp_title: 'Universitetləri müqayisə et',
        cmp_sub: 'Seçdiyin universitetlər yan-yana.',
        // Documents
        docs_eyebrow: 'İzləmə',
        docs_title: 'Sənədlərim',
        docs_sub: 'Müraciətiniz üçün lazım olan sənədlər.',
        docs_progress: 'Ümumi irəliləyiş —',
        docs_note_label: 'Qeyd:',
        docs_note: 'sənədin kağız versiyası yanınızdadırsa, telefonla şəklini çəkib birbaşa bura yükləyə bilərsiniz — skaner lazım deyil.',
        docs_empty: 'Sənəd siyahısı hazırlanır. Zəhmət olmasa mərkəzlə əlaqə saxlayın.',
        doc_uploaded: 'Yükləndi',
        doc_approved: '✓ Təsdiqləndi',
        doc_rejected: '❌ Rədd edildi — yenidən yüklə',
        doc_reupload: 'Yenidən yüklə',
        doc_reason: 'Səbəb',
        doc_delete_wrong: 'Səhv faylı sil',
        upload: 'Yüklə',
        // Consultation
        consult_eyebrow: 'Dəstək',
        consult_title: 'Konsultasiya',
        consult_sub: 'Təcrübəli məsləhətçilərlə görüş planlaşdır.',
        my_meetings: 'Sizin görüşləriniz',
        advisors: 'Məsləhətçilər',
        book_meeting: 'Görüş planlaşdır',
        meeting_type: 'Görüş növü',
        type_online: 'Online',
        type_office: 'Canlı (Mərkəzdə)',
        lbl_date: 'Tarix',
        lbl_time: 'Saat',
        confirm_meeting: 'Görüşü təsdiqlə',
        cancel_meeting: 'Ləğv et',
        // Profile
        profile_edu: 'Təhsil profili',
        pr_level: 'Hədəf dərəcə',
        pr_field: 'Sahə',
        pr_budget: 'Büdcə (illik)',
        pr_score: 'İmtahan balı',
        pr_countries: 'Hədəf ölkələr',
        pr_next_consult: 'Gələcək konsultasiya',
        lang_section: 'Dil seçimi',
        edit_profile: 'Profili redaktə et',
        logout: 'Hesabdan çıx',
        // Onboarding
        onb_back: '← Geri',
        onb_eyebrow: 'Profil',
        onb_title: 'Sənin profilin',
        onb_sub: 'Bu məlumatlar sənə uyğun universitet və proqramları tapmaq üçündür.',
        onb_progress: 'Doldurulma —',
        onb_draft_note: '✓ Yazdıqlarınız avtomatik saxlanılır — yarımçıq qoysanız da itməyəcək.',
        lbl_phone: 'Telefon nömrəsi',
        q_countries: 'Hansı ölkələrdə oxumaq istəyirsən? (maks. 5)',
        q_universities: 'Hansı universitetlərdə oxumaq istəyirsən? (maks. 5)',
        q_uni_hint: 'Əvvəlcə yuxarıdan ölkə seç.',
        q_custom_uni: 'Sizin seçdiyiniz universitet (əgər siyahıda yoxdursa)',
        q_fields: 'Hansı bölmələrdə / ixtisaslarda oxumaq istəyirsən? (maks. 5)',
        q_level: 'Səviyyə',
        lvl_bachelor: 'Bakalavr',
        lvl_master: 'Magistr',
        q_exams: 'Hansı imtahan nəticələrin / sertifikatların var?',
        q_budget: 'Təxmini illik büdcən (təhsil haqqı + yaşayış)',
        budget_other: 'Digər (özün yaz)',
        budget_other_ph: 'məs. 5000 $ və ya 10000 ₼',
        submit_profile: 'Profili tamamla',
        // Result
        res_back: '← Formu düzəlt',
        res_eyebrow: 'Profil hazırdır',
        res_title: 'Təşəkkürlər',
        res_sub: 'Profilin əsasında sənə uyğun addımlar bunlardır.',
        res_summary: 'Profil xülasəsi',
        r_name: 'Ad soyad', r_father_name: 'Ata adı', r_email: 'E-poçt', r_phone: 'Telefon', r_country: 'Ölkə',
        r_university: 'Universitet', r_field: 'Bölmə', r_level: 'Səviyyə',
        r_exams: 'İmtahan / sertifikat', r_score: 'Nəticə balı', r_budget: 'İllik büdcə',
        next_step: 'Növbəti addım',
        contact_center: 'Bilik Tədris Mərkəzi ilə əlaqə',
        contact_center_sub: 'Konkret hansı proqramlara uyğun olduğunu müraciət şərtlərini məsləhətçi ilə görüşdə dəqiqləşdirə bilərsən.',
        go_consult: 'Konsultasiyaya yaz',
        // Nav
        nav_home: 'Əsas', nav_form: 'Formu doldur', nav_unis: 'Universitet',
        nav_docs: 'Sənədlər', nav_consult: 'Konsult.', nav_profile: 'Profil',
        // Notifications
        notifications: 'Bildirişlər',
        notif_announcement_title: 'Mərkəzdən elan',
        notif_confirmed_title: 'Görüşünüz təsdiqləndi',
        notif_confirmed_tpl: '{date} tarixində saat {time}-da {advisor} ilə görüşəcəksiniz',
        parent_view_eyebrow: 'Valideyn görünüşü',
        parent_view_loading: 'Yüklənir...',
        parent_view_invalid_title: 'Link etibarsızdır',
        parent_view_invalid_sub: 'Bu link artıq aktiv deyil və ya ləğv edilib. Mərkəzlə əlaqə saxlayın.',
        parent_view_docs: 'Sənəd irəliləyişi',
        parent_view_doc_tpl: '{done}/{total} sənəd hazırdır',
        parent_view_countries: 'Hədəf ölkələr',
        parent_view_consult: 'Növbəti konsultasiya',
        parent_view_trialexams: 'Sınaq imtahanları',
        parent_view_footer: 'Bu, yalnız-oxu görünüşdür — Bilik Tədris Mərkəzi tərəfindən paylaşılıb.',
        parent_view_none: 'Hələ seçilməyib',
        notif_reminder_title: 'Yaxınlaşan görüş',
        notif_reminder_hours_tpl: '{hours} saat qalıb',
        notif_exam_title: 'Sınaq nəticəniz əlavə edildi',
        close: 'Bağla',
        // About us
        abt_center_desc: 'Bilik Tədris Mərkəzi 2007-ci ildən etibarən Sumqayıt şəhərində fəaliyyət göstərməyə başladı. Bu günə qədər yüzlərlə şagird və tələbənin uğur yolunda yanlarında olmuşdur. Tədris mərkəzimiz, təhsildə keyfiyyətə, nəticəyə və etibara əsaslanan yanaşması ilə valideynlərin və gənclərin etibar etdiyi nüfuzlu bir quruma çevrilmişdir. Bu səbəbdən də, ikinci filialımız 2011-ci ildən Bakı şəhərində fəaliyyətə başladı. Bu illər ərzində biz yerli və beynəlxalq təhsil istiqamətləri üzrə uğurlu nəticələr əldə etmiş, onlarla tələbənin ali məktəblərə və xaricdə təhsilə qəbuluna nail olmuşuq.',
        abt_mission_title: 'Missiyamız',
        abt_mission_body: 'Təhsili yalnız imtahana hazırlıq kimi deyil, həyata hazırlıq kimi təqdim etmək. Bizim məqsədimiz – gəncləri düşünən, tətbiq edən və gələcəyə inamla addımlayan fərdlərə çevirməkdir.',
        abt_services_title: 'Təklif etdiyimiz xidmətlər',
        abt_svc_1: 'Abituriyent hazırlığı (DİM, buraxılış, qəbul imtahanları)',
        abt_svc_2: 'YÖS və SAT imtahanlarına hazırlıq',
        abt_svc_3: 'Ümumi ingilis dili üzrə kurslar',
        abt_svc_4: 'Beynəlxalq sertifikasiya imtahanlarına hazırlıq (TOEFL, IELTS, GRE, GMAT)',
        abt_svc_5: 'Riyaziyyat və informatika dərsləri (o cümlədən olimpiada hazırlığı)',
        abt_svc_6: 'Xaricdə təhsil üzrə konsultasiya və qeydiyyat',
        abt_svc_7: 'Ali riyaziyyat və fizika fənləri üzrə dərslər (tələbələr üçün)',
        abt_teachers_title: 'Müəllim heyətimiz',
        abt_teachers_body: 'Bilik Tədris Mərkəzində yalnız peşəkar, təcrübəli və ixtisaslı müəllimlər fəaliyyət göstərir. Hər müəllim öz sahəsində müasir tədris metodlarını tətbiq edir və hər bir şagirdə fərdi yanaşma göstərir. Müəllimlərimiz həm akademik bilik, həm də psixoloji yanaşma baxımından öyrənməyə motivasiya yaradır.',
        abt_achieve_title: 'Uğurlarımız',
        abt_achieve_1: '2007-ci ildən bu günə qədər minlərlə tələbəyə təhsil xidməti göstərilmişdir',
        abt_achieve_2: 'Onlarla tələbəmiz xaricdə təhsil alır – Türkiyə, Almaniya, Polşa və digər ölkələrdə',
        abt_achieve_3: 'Dəfələrlə olimpiada və sınaq imtahanlarında yüksək nəticələr',
        abt_achieve_4: 'Valideynlərin məmnuniyyəti və tövsiyələri ilə daim böyüyən bir mərkəz',
        abt_why_title: 'Niyə bizi seçirlər?',
        abt_why_1: '✅ 17 ildən çox təcrübə – 2007-dən bu günə',
        abt_why_2: '✅ Keyfiyyətli və müasir tədris yanaşması',
        abt_why_3: '✅ Hər bir tələbəyə fərdi proqram və izah',
        abt_why_4: '✅ Real nəticələr, real uğurlar',
        abt_why_5: '✅ Davamlı dəstək və istiqamət',
        abt_why_6: '✅ Ailələrlə müntəzəm əlaqə və hesabatlılıq',
        abt_closing_title: 'Uğura aparan yolun başlanğıcı',
        abt_closing_body: 'Əgər siz də övladınız üçün təhlükəsiz, müasir və nəticə yönümlü bir təhsil mərkəzi axtarırsınızsa, Bilik Tədris Mərkəzi doğru ünvandır. Gələcəyin ali məktəb tələbələri, peşəkarları və liderləri burada yetişir.',
        abt_copyright: '© 2026 Bilik Tədris Mərkəzi. Bütün hüquqlar qorunur.',
        // Achievements admin section
        achievements_title: 'Nailiyyətlərimiz',
        achievements_empty: 'Hələ heç bir nailiyyət əlavə olunmayıb.',
        services_empty: 'Hələ xidmət əlavə olunmayıb.',
        team_title: 'Əməkdaşlarımız',
        team_empty: 'Hələ əməkdaş əlavə olunmayıb.',
        partner_unis_title: 'Əməkdaş universitetlər',
        partner_unis_empty: 'Hələ əməkdaş universitet əlavə olunmayıb.',
        news_title: 'Elanlar / Xəbərlər',
        news_empty: 'Hələ xəbər əlavə olunmayıb.',
        // Ev ekranı — "Növbəti addım" kartı
        ns_fill_profile_title: 'Profilini doldur',
        ns_fill_profile_sub: 'Ölkə, ixtisas və büdcəni qeyd et ki, sənə uyğun universitetləri göstərək.',
        ns_pick_unis_title: 'Universitet seç',
        ns_pick_unis_sub: 'Profilinə uyğun universitetlərə bax və maraqlandıqlarını seç.',
        ns_first_doc_title: 'İlk sənədini yüklə',
        ns_first_doc_sub: 'Müraciət üçün lazım olan sənədləri telefonla şəkil çəkib yükləyə bilərsən.',
        ns_docs_btn: 'Sənədlərə keç',
        ns_docs_left_title_tpl: '{left} sənəd qalıb',
        ns_docs_left_sub_tpl: '{total} sənəddən {done}-i hazırdır. Qalanlarını da yüklə.',
        ns_consult_title: 'Konsultasiya al',
        ns_consult_sub: 'Sənədlərin hazırdır. İndi məsləhətçi ilə görüş planlaşdır.',
        ns_consult_btn: 'Görüş planlaşdır',
        ns_done_title: 'Hər şey qaydasındadır',
        ns_done_sub: 'Profilin, sənədlərin və görüşün hazırdır. Növbəti addımları məsləhətçin sənə deyəcək.',
        ns_done_btn: 'Görüşlərimə bax',
        ns_docs_chip_tpl: 'Sənədlər {done}/{total}',
        ns_deadline_overdue_tpl: '{name} — vaxtı keçib',
        ns_deadline_today_tpl: '{name} — son gün',
        ns_deadline_days_tpl: '{name} — {days} gün qalıb'
      },

      en: {
        page_title: 'BTM - Study Abroad',
        years_with_you: '20 years with you',
        splash_tag: 'Your study abroad route — from university selection to visa documents, all in one place.',
        splash_start: 'Start',
        uni_search_ph: '🔍 Search university...',
        login: 'Log in',
        login_sub: 'Sign in to your account',
        lbl_email: 'Email address',
        lbl_password: 'Password',
        btn_login: 'Log in',
        forgot_password: 'Forgot your password?',
        no_account: "Don't have an account?",
        register: 'Sign up',
        register_sub: 'Create a new account',
        lbl_fullname: 'First & last name',
        lbl_father_name: "Father's name",
        register_btn: 'Sign up',
        have_account: 'Already have an account?',
        fp_title: 'Reset password',
        fp_sub: 'Enter your email address and we will send you a reset link.',
        fp_send: 'Send link',
        fp_back: '← Back to login',
        login_locked_tpl: 'Too many attempts — try again in {mins} minute(s).',
        rp_title: 'Set a new password',
        rp_sub: 'Enter a new password for your account.',
        lbl_new_password: 'New password',
        lbl_confirm_password: 'Repeat new password',
        rp_update: 'Update password',
        welcome: 'Welcome',
        greeting: 'Hello, Student',
        home_sub: 'Your education journey starts with Bilik.',
        srv_dim: 'Admission prep',
        srv_yos: 'Exam prep',
        srv_abroad: 'Abroad',
        srv_abroad_sub: 'Education & visa',
        srv_math: 'Mathematics',
        srv_math_sub: '& Olympiad',
        srv_higher_math: 'Higher Math',
        srv_higher_math_sub: '& Physics',
        home_card_partners_title: 'Partners',
        home_card_partners_sub: 'Universities',
        home_card_services_title: 'Services',
        home_card_services_sub: 'With pricing',
        home_card_achieve_title: 'Achievements',
        home_card_achieve_sub: 'Our success',
        home_card_team_title: 'Team',
        home_card_team_sub: 'Teachers',
        home_card_news_title: 'News',
        home_card_news_sub: 'Announcements',
        home_card_trialexams_title: 'Trial exams',
        home_card_trialexams_sub: 'Paid',
        trialexams_title: 'Paid Trial Exams',
        trialexams_empty: 'No trial exams added yet.',
        trialexams_register: 'Register',
        trialexams_paid: 'Paid',
        trialexams_pending: 'Pending',
        trialexams_cancel: 'Cancel',
        trialexams_registered_toast: 'You have registered',
        trialexams_cancelled_toast: 'Cancelled',
        trialexams_cancel_confirm: 'Are you sure you want to cancel this registration?',
        trialexams_start: 'Start exam',
        trialexams_exit: 'Exit',
        trialexams_prev: 'Back',
        trialexams_next: 'Next',
        trialexams_submit: 'Submit',
        trialexams_no_questions_title: 'Questions not ready yet',
        trialexams_no_questions_sub: 'No questions have been added for this exam yet. Please contact the centre.',
        trialexams_not_eligible_title: "You don't have access to this exam yet",
        trialexams_not_eligible_sub: 'You can start the exam once your payment is confirmed.',
        trialexams_already_taken_title: 'You have already taken this exam',
        trialexams_already_taken_sub: 'You can see your result in the "Trial exams" section.',
        trialexams_error_title: 'Something went wrong',
        trialexams_error_sub: 'Please try again in a moment.',
        trialexams_submit_confirm: "Once submitted you won't be able to review the questions again. Are you sure?",
        trialexams_submit_confirm_unanswered: 'You have {n} unanswered question(s). Submit anyway?',
        notif_trialexam_paid_title: 'Your trial exam payment was confirmed',
        notif_trialexam_pending_title: 'Your trial exam registration was received',
        notif_trialexam_result_title: 'Your trial exam result is ready',
        trialexams_correct_short: 'correct',
        trialexams_wrong_short: 'wrong',
        stat_unis: 'Selected university',
        stat_docs: 'Completed document',
        stat_consults: 'Planned consultation',
        complete_profile: 'Complete your profile',
        complete_profile_sub: 'Fill in country, field, exam results and budget so we can show programmes that fit you.',
        fill_form: 'Fill the form',
        selected_unis: 'Your selected universities',
        about_us: 'About us',
        unis_eyebrow: 'Search',
        unis_title: 'Universities',
        unis_sub: 'Countries and fields come from the same list as your profile — the match is calculated from your profile.',
        uni_empty: 'No university matches this search.',
        all_countries: 'All',
        uni_filter_mine: 'My countries',
        pick_unis_title: 'Make your university choice',
        pick_unis_sub: 'Browse every university in your chosen countr(y/ies) and pick the ones that suit you.',
        pick_unis_btn: 'Browse universities',
        cmp_back: '← Back to universities',
        cmp_eyebrow: 'Comparison',
        cmp_title: 'Compare universities',
        cmp_sub: 'Your selected universities side by side.',
        docs_eyebrow: 'Tracking',
        docs_title: 'My documents',
        docs_sub: 'Documents required for your application.',
        docs_progress: 'Overall progress —',
        docs_note_label: 'Note:',
        docs_note: 'if you have the paper version at hand, just photograph it with your phone and upload it here — no scanner needed.',
        docs_empty: 'The document list is being prepared. Please contact the centre.',
        doc_uploaded: 'Uploaded',
        doc_approved: '✓ Approved',
        doc_rejected: '❌ Rejected — please re-upload',
        doc_reupload: 'Re-upload',
        doc_reason: 'Reason',
        doc_delete_wrong: 'Delete wrong file',
        upload: 'Upload',
        consult_eyebrow: 'Support',
        consult_title: 'Consultation',
        consult_sub: 'Book a meeting with experienced advisors.',
        my_meetings: 'Your meetings',
        advisors: 'Advisors',
        book_meeting: 'Book a meeting',
        meeting_type: 'Meeting type',
        type_online: 'Online',
        type_office: 'In person (at the centre)',
        lbl_date: 'Date',
        lbl_time: 'Time',
        confirm_meeting: 'Confirm meeting',
        cancel_meeting: 'Cancel',
        profile_edu: 'Education profile',
        pr_level: 'Target degree',
        pr_field: 'Field',
        pr_budget: 'Budget (yearly)',
        pr_score: 'Exam score',
        pr_countries: 'Target countries',
        pr_next_consult: 'Upcoming consultation',
        lang_section: 'Language',
        edit_profile: 'Edit profile',
        logout: 'Log out',
        onb_back: '← Back',
        onb_eyebrow: 'Profile',
        onb_title: 'Your profile',
        onb_sub: 'This information helps us find universities and programmes that fit you.',
        onb_progress: 'Completed —',
        onb_draft_note: '✓ Your answers are saved automatically — nothing is lost if you stop halfway.',
        lbl_phone: 'Phone number',
        q_countries: 'Which countries would you like to study in? (max 5)',
        q_universities: 'Which universities would you like to study at? (max 5)',
        q_uni_hint: 'Select a country above first.',
        q_custom_uni: 'Your own university (if it is not in the list)',
        q_fields: 'Which fields would you like to study? (max 5)',
        q_level: 'Level',
        lvl_bachelor: "Bachelor's",
        lvl_master: "Master's",
        q_exams: 'Which exam results / certificates do you have?',
        q_budget: 'Approximate yearly budget (tuition + living)',
        budget_other: 'Other (type your own)',
        budget_other_ph: 'e.g. $5000 or ₼10000',
        submit_profile: 'Complete profile',
        res_back: '← Edit the form',
        res_eyebrow: 'Profile ready',
        res_title: 'Thank you',
        res_sub: 'Based on your profile, these are your next steps.',
        res_summary: 'Profile summary',
        r_name: 'Full name', r_father_name: "Father's name", r_email: 'Email', r_phone: 'Phone', r_country: 'Country',
        r_university: 'University', r_field: 'Field', r_level: 'Level',
        r_exams: 'Exam / certificate', r_score: 'Score', r_budget: 'Yearly budget',
        next_step: 'Next step',
        contact_center: 'Contact Bilik Education Centre',
        contact_center_sub: 'You can clarify which programmes you qualify for and the application requirements during a meeting with an advisor.',
        go_consult: 'Book a consultation',
        nav_home: 'Home', nav_form: 'Fill form', nav_unis: 'Universities',
        nav_docs: 'Documents', nav_consult: 'Consult.', nav_profile: 'Profile',
        notifications: 'Notifications',
        notif_announcement_title: 'Announcement',
        notif_confirmed_title: 'Your meeting is confirmed',
        notif_confirmed_tpl: 'You will meet with {advisor} on {date} at {time}',
        parent_view_eyebrow: 'Parent view',
        parent_view_loading: 'Loading...',
        parent_view_invalid_title: 'Link is invalid',
        parent_view_invalid_sub: 'This link is no longer active or has been revoked. Please contact the centre.',
        parent_view_docs: 'Document progress',
        parent_view_doc_tpl: '{done}/{total} documents ready',
        parent_view_countries: 'Target countries',
        parent_view_consult: 'Next consultation',
        parent_view_trialexams: 'Trial exams',
        parent_view_footer: 'This is a read-only view shared by Bilik Education Centre.',
        parent_view_none: 'Not selected yet',
        notif_reminder_title: 'Upcoming meeting',
        notif_reminder_hours_tpl: '{hours}h left',
        notif_exam_title: 'Your exam result was added',
        close: 'Close',
        // About us
        abt_center_desc: 'Bilik Education Centre has been operating in Sumgait since 2007. To this day it has stood beside hundreds of pupils and students on their path to success. Built on quality, results and trust in education, our centre has become a name that parents and young people rely on. That is why our second branch opened in Baku in 2011. Over the years we have achieved strong results in local and international education, helping dozens of students gain admission to universities and study abroad.',
        abt_mission_title: 'Our mission',
        abt_mission_body: 'To present education not just as exam preparation, but as preparation for life. Our goal is to turn young people into individuals who think, apply what they learn, and step into the future with confidence.',
        abt_services_title: 'Our services',
        abt_svc_1: 'Exam preparation for school leavers (national exams, graduation, admission tests)',
        abt_svc_2: 'YÖS and SAT exam preparation',
        abt_svc_3: 'General English courses',
        abt_svc_4: 'International certification exam preparation (TOEFL, IELTS, GRE, GMAT)',
        abt_svc_5: 'Maths and computer science classes (including olympiad training)',
        abt_svc_6: 'Study-abroad consulting and enrolment',
        abt_svc_7: 'Higher maths and physics classes (for university students)',
        abt_teachers_title: 'Our teaching staff',
        abt_teachers_body: 'Only professional, experienced and qualified teachers work at Bilik Education Centre. Every teacher applies modern teaching methods in their field and takes an individual approach to each student. Our teachers build motivation to learn through both academic knowledge and a psychological approach.',
        abt_achieve_title: 'Our achievements',
        abt_achieve_1: 'Since 2007 we have provided education services to thousands of students',
        abt_achieve_2: 'Dozens of our students are studying abroad — in Turkey, Germany, Poland and other countries',
        abt_achieve_3: 'Repeated top results in olympiads and mock exams',
        abt_achieve_4: 'A centre that keeps growing through the satisfaction and referrals of parents',
        abt_why_title: 'Why they choose us',
        abt_why_1: '✅ Over 17 years of experience — since 2007',
        abt_why_2: '✅ Quality, modern teaching approach',
        abt_why_3: '✅ An individual programme and explanation for every student',
        abt_why_4: '✅ Real results, real success',
        abt_why_5: '✅ Ongoing support and guidance',
        abt_why_6: '✅ Regular contact and reporting with families',
        abt_closing_title: 'The start of the road to success',
        abt_closing_body: 'If you are looking for a safe, modern, results-driven education centre for your child, Bilik Education Centre is the right address. The university students, professionals and leaders of the future grow up here.',
        abt_copyright: '© 2026 Bilik Education Centre. All rights reserved.',
        achievements_title: 'Our achievements',
        achievements_empty: 'No achievements have been added yet.',
        services_empty: 'No services have been added yet.',
        team_title: 'Our team',
        team_empty: 'No team members have been added yet.',
        partner_unis_title: 'Partner universities',
        partner_unis_empty: 'No partner universities have been added yet.',
        news_title: 'Announcements / News',
        news_empty: 'No news posted yet.',
        ns_fill_profile_title: 'Fill your profile',
        ns_fill_profile_sub: 'Add your country, field and budget so we can show you matching universities.',
        ns_pick_unis_title: 'Pick universities',
        ns_pick_unis_sub: 'Browse universities that match your profile and pick the ones you like.',
        ns_first_doc_title: 'Upload your first document',
        ns_first_doc_sub: 'You can photograph and upload the documents needed for your application.',
        ns_docs_btn: 'Go to documents',
        ns_docs_left_title_tpl: '{left} documents left',
        ns_docs_left_sub_tpl: '{done} of {total} documents are ready. Upload the rest.',
        ns_consult_title: 'Book a consultation',
        ns_consult_sub: 'Your documents are ready. Now plan a meeting with an advisor.',
        ns_consult_btn: 'Plan a meeting',
        ns_done_title: 'Everything is in order',
        ns_done_sub: 'Your profile, documents and meeting are ready. Your advisor will tell you the next steps.',
        ns_done_btn: 'View my meetings',
        ns_docs_chip_tpl: 'Documents {done}/{total}',
        ns_deadline_overdue_tpl: '{name} — overdue',
        ns_deadline_today_tpl: '{name} — due today',
        ns_deadline_days_tpl: '{name} — {days} days left'
      },

      ru: {
        page_title: 'BTM - Обучение за рубежом',
        years_with_you: '20 лет с вами',
        splash_tag: 'Ваш маршрут обучения за рубежом — от выбора университета до визовых документов, всё в одном месте.',
        splash_start: 'Начать',
        uni_search_ph: '🔍 Поиск университета...',
        login: 'Вход',
        login_sub: 'Войдите в свой аккаунт',
        lbl_email: 'Адрес эл. почты',
        lbl_password: 'Пароль',
        btn_login: 'Войти',
        forgot_password: 'Забыли пароль?',
        no_account: 'Нет аккаунта?',
        register: 'Регистрация',
        register_sub: 'Создайте новый аккаунт',
        lbl_fullname: 'Имя и фамилия',
        lbl_father_name: 'Отчество',
        register_btn: 'Зарегистрироваться',
        have_account: 'Уже есть аккаунт?',
        fp_title: 'Восстановление пароля',
        fp_sub: 'Введите адрес эл. почты, и мы отправим ссылку для восстановления.',
        fp_send: 'Отправить ссылку',
        fp_back: '← Вернуться ко входу',
        login_locked_tpl: 'Слишком много попыток — повторите через {mins} мин.',
        rp_title: 'Новый пароль',
        rp_sub: 'Введите новый пароль для вашего аккаунта.',
        lbl_new_password: 'Новый пароль',
        lbl_confirm_password: 'Повторите новый пароль',
        rp_update: 'Обновить пароль',
        welcome: 'Добро пожаловать',
        greeting: 'Привет, Студент',
        home_sub: 'Ваш путь к образованию начинается с Bilik.',
        srv_dim: 'Подготовка к поступл.',
        srv_yos: 'Подготовка к экзам.',
        srv_abroad: 'За рубежом',
        srv_abroad_sub: 'Обучение и виза',
        srv_math: 'Математика',
        srv_math_sub: '& Олимпиада',
        srv_higher_math: 'Высшая математика',
        srv_higher_math_sub: '& Физика',
        home_card_partners_title: 'Партнёры',
        home_card_partners_sub: 'Университеты',
        home_card_services_title: 'Услуги',
        home_card_services_sub: 'С ценами',
        home_card_achieve_title: 'Достижения',
        home_card_achieve_sub: 'Наши успехи',
        home_card_team_title: 'Команда',
        home_card_team_sub: 'Учителя',
        home_card_news_title: 'Новости',
        home_card_news_sub: 'Объявления',
        home_card_trialexams_title: 'Пробные',
        home_card_trialexams_sub: 'Платные',
        trialexams_title: 'Платные Пробные Экзамены',
        trialexams_empty: 'Пробные экзамены пока не добавлены.',
        trialexams_register: 'Записаться',
        trialexams_paid: 'Оплачено',
        trialexams_pending: 'Ожидается',
        trialexams_cancel: 'Отменить',
        trialexams_registered_toast: 'Вы записались',
        trialexams_cancelled_toast: 'Отменено',
        trialexams_cancel_confirm: 'Вы уверены, что хотите отменить эту запись?',
        trialexams_start: 'Начать экзамен',
        trialexams_exit: 'Выйти',
        trialexams_prev: 'Назад',
        trialexams_next: 'Далее',
        trialexams_submit: 'Отправить',
        trialexams_no_questions_title: 'Вопросы ещё не готовы',
        trialexams_no_questions_sub: 'Для этого экзамена пока не добавлены вопросы. Свяжитесь с центром.',
        trialexams_not_eligible_title: 'У вас пока нет доступа к этому экзамену',
        trialexams_not_eligible_sub: 'Вы сможете начать экзамен после подтверждения оплаты.',
        trialexams_already_taken_title: 'Вы уже прошли этот экзамен',
        trialexams_already_taken_sub: 'Результат можно посмотреть в разделе «Пробные экзамены».',
        trialexams_error_title: 'Произошла ошибка',
        trialexams_error_sub: 'Попробуйте ещё раз через некоторое время.',
        trialexams_submit_confirm: 'После отправки вы не сможете снова просмотреть вопросы. Вы уверены?',
        trialexams_submit_confirm_unanswered: 'У вас {n} вопрос(ов) без ответа. Всё равно отправить?',
        notif_trialexam_paid_title: 'Ваша оплата пробного экзамена подтверждена',
        notif_trialexam_pending_title: 'Ваша запись на пробный экзамен получена',
        notif_trialexam_result_title: 'Ваш результат пробного экзамена готов',
        trialexams_correct_short: 'правильно',
        trialexams_wrong_short: 'неправильно',
        stat_unis: 'Выбранный университет',
        stat_docs: 'Завершённый документ',
        stat_consults: 'Запланир. консультация',
        complete_profile: 'Заполните профиль',
        complete_profile_sub: 'Укажите страну, специальность, результаты экзаменов и бюджет, чтобы мы подобрали подходящие программы.',
        fill_form: 'Заполнить форму',
        selected_unis: 'Выбранные вами университеты',
        about_us: 'О нас',
        unis_eyebrow: 'Поиск',
        unis_title: 'Университеты',
        unis_sub: 'Страны и специальности берутся из того же списка, что и в профиле — совпадение рассчитывается по вашему профилю.',
        uni_empty: 'По этому запросу университеты не найдены.',
        all_countries: 'Все',
        uni_filter_mine: 'Мои страны',
        pick_unis_title: 'Выберите университеты',
        pick_unis_sub: 'Просмотрите все университеты в выбранных вами странах и выберите подходящие.',
        pick_unis_btn: 'Смотреть университеты',
        cmp_back: '← Назад к университетам',
        cmp_eyebrow: 'Сравнение',
        cmp_title: 'Сравнить университеты',
        cmp_sub: 'Выбранные вами университеты рядом.',
        docs_eyebrow: 'Отслеживание',
        docs_title: 'Мои документы',
        docs_sub: 'Документы, необходимые для вашей заявки.',
        docs_progress: 'Общий прогресс —',
        docs_note_label: 'Примечание:',
        docs_note: 'если бумажная версия документа у вас под рукой, просто сфотографируйте её телефоном и загрузите сюда — сканер не нужен.',
        docs_empty: 'Список документов готовится. Пожалуйста, свяжитесь с центром.',
        doc_uploaded: 'Загружено',
        doc_approved: '✓ Одобрено',
        doc_rejected: '❌ Отклонено — загрузите заново',
        doc_reupload: 'Загрузить заново',
        doc_reason: 'Причина',
        doc_delete_wrong: 'Удалить неверный файл',
        upload: 'Загрузить',
        consult_eyebrow: 'Поддержка',
        consult_title: 'Консультация',
        consult_sub: 'Запишитесь на встречу с опытными консультантами.',
        my_meetings: 'Ваши встречи',
        advisors: 'Консультанты',
        book_meeting: 'Записаться на встречу',
        meeting_type: 'Формат встречи',
        type_online: 'Онлайн',
        type_office: 'Лично (в центре)',
        lbl_date: 'Дата',
        lbl_time: 'Время',
        confirm_meeting: 'Подтвердить встречу',
        cancel_meeting: 'Отменить',
        profile_edu: 'Образовательный профиль',
        pr_level: 'Целевая степень',
        pr_field: 'Направление',
        pr_budget: 'Бюджет (в год)',
        pr_score: 'Балл экзамена',
        pr_countries: 'Целевые страны',
        pr_next_consult: 'Предстоящая консультация',
        lang_section: 'Выбор языка',
        edit_profile: 'Редактировать профиль',
        logout: 'Выйти',
        onb_back: '← Назад',
        onb_eyebrow: 'Профиль',
        onb_title: 'Ваш профиль',
        onb_sub: 'Эти данные нужны, чтобы подобрать подходящие университеты и программы.',
        onb_progress: 'Заполнено —',
        onb_draft_note: '✓ Ваши ответы сохраняются автоматически — ничего не потеряется, если прерветесь.',
        lbl_phone: 'Номер телефона',
        q_countries: 'В каких странах вы хотите учиться? (макс. 5)',
        q_universities: 'В каких университетах вы хотите учиться? (макс. 5)',
        q_uni_hint: 'Сначала выберите страну выше.',
        q_custom_uni: 'Ваш вариант университета (если его нет в списке)',
        q_fields: 'Какие специальности вас интересуют? (макс. 5)',
        q_level: 'Уровень',
        lvl_bachelor: 'Бакалавриат',
        lvl_master: 'Магистратура',
        q_exams: 'Какие результаты экзаменов / сертификаты у вас есть?',
        q_budget: 'Примерный годовой бюджет (обучение + проживание)',
        budget_other: 'Другое (укажите сами)',
        budget_other_ph: 'напр. 5000 $ или 10000 ₼',
        submit_profile: 'Завершить профиль',
        res_back: '← Изменить форму',
        res_eyebrow: 'Профиль готов',
        res_title: 'Спасибо',
        res_sub: 'На основе вашего профиля — следующие шаги.',
        res_summary: 'Сводка профиля',
        r_name: 'Имя и фамилия', r_father_name: 'Отчество', r_email: 'Эл. почта', r_phone: 'Телефон', r_country: 'Страна',
        r_university: 'Университет', r_field: 'Направление', r_level: 'Уровень',
        r_exams: 'Экзамен / сертификат', r_score: 'Балл', r_budget: 'Годовой бюджет',
        next_step: 'Следующий шаг',
        contact_center: 'Связаться с центром Bilik',
        contact_center_sub: 'Какие именно программы вам подходят и условия подачи можно уточнить на встрече с консультантом.',
        go_consult: 'Записаться на консультацию',
        nav_home: 'Главная', nav_form: 'Заполнить', nav_unis: 'Университеты',
        nav_docs: 'Документы', nav_consult: 'Консульт.', nav_profile: 'Профиль',
        notifications: 'Уведомления',
        notif_announcement_title: 'Объявление центра',
        notif_confirmed_title: 'Ваша встреча подтверждена',
        notif_confirmed_tpl: 'Вы встретитесь с {advisor} {date} в {time}',
        parent_view_eyebrow: 'Вид для родителей',
        parent_view_loading: 'Загрузка...',
        parent_view_invalid_title: 'Ссылка недействительна',
        parent_view_invalid_sub: 'Эта ссылка больше не активна или отозвана. Свяжитесь с центром.',
        parent_view_docs: 'Прогресс по документам',
        parent_view_doc_tpl: 'Готово {done}/{total} документов',
        parent_view_countries: 'Целевые страны',
        parent_view_consult: 'Следующая консультация',
        parent_view_trialexams: 'Пробные экзамены',
        parent_view_footer: 'Это доступный только для чтения вид, предоставленный центром Bilik.',
        parent_view_none: 'Пока не выбрано',
        notif_reminder_title: 'Скоро встреча',
        notif_reminder_hours_tpl: 'осталось {hours} ч.',
        notif_exam_title: 'Добавлен результат вашего экзамена',
        close: 'Закрыть',
        // About us
        abt_center_desc: 'Учебный центр Bilik работает в Сумгаите с 2007 года. За это время он стал опорой для сотен учеников и студентов на пути к успеху. Благодаря подходу, основанному на качестве, результате и доверии, центр стал авторитетным учреждением, которому доверяют родители и молодёжь. Поэтому в 2011 году в Баку открылся второй филиал. За эти годы центр добился успешных результатов в местном и международном образовании, помогая десяткам студентов поступать в вузы и учиться за рубежом.',
        abt_mission_title: 'Наша миссия',
        abt_mission_body: 'Представлять образование не только как подготовку к экзаменам, но и как подготовку к жизни. Наша цель — превратить молодых людей в личностей, которые думают, применяют знания и уверенно шагают в будущее.',
        abt_services_title: 'Наши услуги',
        abt_svc_1: 'Подготовка абитуриентов (госэкзамены, выпускные, вступительные экзамены)',
        abt_svc_2: 'Подготовка к экзаменам YÖS и SAT',
        abt_svc_3: 'Курсы общего английского языка',
        abt_svc_4: 'Подготовка к международным сертификационным экзаменам (TOEFL, IELTS, GRE, GMAT)',
        abt_svc_5: 'Уроки математики и информатики (включая подготовку к олимпиадам)',
        abt_svc_6: 'Консультации и оформление документов для обучения за рубежом',
        abt_svc_7: 'Уроки высшей математики и физики (для студентов)',
        abt_teachers_title: 'Наш преподавательский состав',
        abt_teachers_body: 'В учебном центре Bilik работают только профессиональные, опытные и квалифицированные преподаватели. Каждый преподаватель применяет современные методы обучения в своей области и находит индивидуальный подход к каждому ученику. Наши преподаватели создают мотивацию к обучению как через академические знания, так и через психологический подход.',
        abt_achieve_title: 'Наши достижения',
        abt_achieve_1: 'С 2007 года образовательные услуги получили тысячи студентов',
        abt_achieve_2: 'Десятки наших студентов учатся за рубежом — в Турции, Германии, Польше и других странах',
        abt_achieve_3: 'Неоднократные высокие результаты на олимпиадах и пробных экзаменах',
        abt_achieve_4: 'Центр, который постоянно растёт благодаря удовлетворённости и рекомендациям родителей',
        abt_why_title: 'Почему выбирают нас',
        abt_why_1: '✅ Более 17 лет опыта — с 2007 года',
        abt_why_2: '✅ Качественный и современный подход к обучению',
        abt_why_3: '✅ Индивидуальная программа и объяснение для каждого студента',
        abt_why_4: '✅ Реальные результаты, реальные успехи',
        abt_why_5: '✅ Постоянная поддержка и сопровождение',
        abt_why_6: '✅ Регулярная связь и отчётность перед семьями',
        abt_closing_title: 'Начало пути к успеху',
        abt_closing_body: 'Если вы ищете для своего ребёнка безопасный, современный и ориентированный на результат учебный центр, Bilik — правильный выбор. Здесь растут студенты вузов, профессионалы и лидеры будущего.',
        abt_copyright: '© 2026 Учебный центр Bilik. Все права защищены.',
        achievements_title: 'Наши достижения',
        achievements_empty: 'Пока не добавлено ни одного достижения.',
        services_empty: 'Пока не добавлено ни одной услуги.',
        team_title: 'Наша команда',
        team_empty: 'Пока не добавлено ни одного сотрудника.',
        partner_unis_title: 'Университеты-партнёры',
        partner_unis_empty: 'Пока не добавлено ни одного университета-партнёра.',
        news_title: 'Объявления / Новости',
        news_empty: 'Пока новостей нет.',
        ns_fill_profile_title: 'Заполните профиль',
        ns_fill_profile_sub: 'Укажите страну, специальность и бюджет, чтобы мы показали подходящие университеты.',
        ns_pick_unis_title: 'Выберите университеты',
        ns_pick_unis_sub: 'Просмотрите университеты, подходящие вашему профилю, и выберите понравившиеся.',
        ns_first_doc_title: 'Загрузите первый документ',
        ns_first_doc_sub: 'Вы можете сфотографировать и загрузить документы, нужные для заявки.',
        ns_docs_btn: 'Перейти к документам',
        ns_docs_left_title_tpl: 'Осталось {left} документов',
        ns_docs_left_sub_tpl: 'Готово {done} из {total} документов. Загрузите остальные.',
        ns_consult_title: 'Записаться на консультацию',
        ns_consult_sub: 'Ваши документы готовы. Теперь запланируйте встречу с консультантом.',
        ns_consult_btn: 'Запланировать встречу',
        ns_done_title: 'Всё в порядке',
        ns_done_sub: 'Ваш профиль, документы и встреча готовы. О следующих шагах вам скажет консультант.',
        ns_done_btn: 'Мои встречи',
        ns_docs_chip_tpl: 'Документы {done}/{total}',
        ns_deadline_overdue_tpl: '{name} — просрочено',
        ns_deadline_today_tpl: '{name} — последний день',
        ns_deadline_days_tpl: '{name} — осталось {days} дн.'
      },

      tr: {
        page_title: 'BTM - Yurt Dışı Eğitim',
        years_with_you: '20 yıldır sizinle',
        splash_tag: 'Yurt dışı eğitim rotanız — üniversite seçiminden vize belgelerine kadar tek bir yerde.',
        splash_start: 'Başla',
        uni_search_ph: '🔍 Üniversite ara...',
        login: 'Giriş',
        login_sub: 'Hesabınıza giriş yapın',
        lbl_email: 'E-posta adresi',
        lbl_password: 'Şifre',
        btn_login: 'Giriş yap',
        forgot_password: 'Şifrenizi mi unuttunuz?',
        no_account: 'Hesabınız yok mu?',
        register: 'Kayıt',
        register_sub: 'Yeni hesap oluşturun',
        lbl_fullname: 'Ad ve Soyad',
        lbl_father_name: 'Baba adı',
        register_btn: 'Kayıt ol',
        have_account: 'Zaten hesabınız var mı?',
        fp_title: 'Şifreyi sıfırla',
        fp_sub: 'E-posta adresinizi girin, size sıfırlama bağlantısı gönderelim.',
        fp_send: 'Bağlantı gönder',
        fp_back: '← Girişe dön',
        login_locked_tpl: 'Çok fazla deneme — {mins} dakika sonra tekrar dene.',
        rp_title: 'Yeni şifre belirle',
        rp_sub: 'Hesabınız için yeni bir şifre girin.',
        lbl_new_password: 'Yeni şifre',
        lbl_confirm_password: 'Yeni şifreyi tekrarla',
        rp_update: 'Şifreyi güncelle',
        welcome: 'Hoş geldiniz',
        greeting: 'Merhaba, Öğrenci',
        home_sub: 'Eğitim yolculuğunuz Bilik ile başlıyor.',
        srv_dim: 'Kabul hazırlığı',
        srv_yos: 'Sınav hazırlığı',
        srv_abroad: 'Yurt dışı',
        srv_abroad_sub: 'Eğitim & vize',
        srv_math: 'Matematik',
        srv_math_sub: '& Olimpiyat',
        srv_higher_math: 'Yüksek Matematik',
        srv_higher_math_sub: '& Fizik',
        home_card_partners_title: 'Ortaklar',
        home_card_partners_sub: 'Üniversiteler',
        home_card_services_title: 'Hizmetler',
        home_card_services_sub: 'Fiyatlarla',
        home_card_achieve_title: 'Başarılar',
        home_card_achieve_sub: 'Başarılarımız',
        home_card_team_title: 'Ekip',
        home_card_team_sub: 'Öğretmenler',
        home_card_news_title: 'Haberler',
        home_card_news_sub: 'Duyurular',
        home_card_trialexams_title: 'Deneme',
        home_card_trialexams_sub: 'Ücretli',
        trialexams_title: 'Ücretli Deneme Sınavları',
        trialexams_empty: 'Henüz deneme sınavı eklenmedi.',
        trialexams_register: 'Kayıt ol',
        trialexams_paid: 'Ödendi',
        trialexams_pending: 'Bekleniyor',
        trialexams_cancel: 'İptal et',
        trialexams_registered_toast: 'Kayıt oldunuz',
        trialexams_cancelled_toast: 'İptal edildi',
        trialexams_cancel_confirm: 'Bu kaydı iptal etmek istediğinizden emin misiniz?',
        trialexams_start: 'Sınava başla',
        trialexams_exit: 'Çıkış',
        trialexams_prev: 'Geri',
        trialexams_next: 'İleri',
        trialexams_submit: 'Gönder',
        trialexams_no_questions_title: 'Sorular henüz hazır değil',
        trialexams_no_questions_sub: 'Bu sınav için henüz soru eklenmedi. Merkezle iletişime geçin.',
        trialexams_not_eligible_title: 'Bu sınava henüz erişiminiz yok',
        trialexams_not_eligible_sub: 'Ödemeniz onaylandıktan sonra sınava başlayabilirsiniz.',
        trialexams_already_taken_title: 'Bu sınavı zaten verdiniz',
        trialexams_already_taken_sub: 'Sonucunuzu "Deneme sınavları" bölümünde görebilirsiniz.',
        trialexams_error_title: 'Bir hata oluştu',
        trialexams_error_sub: 'Lütfen biraz sonra tekrar deneyin.',
        trialexams_submit_confirm: 'Gönderdikten sonra soruları tekrar göremeyeceksiniz. Emin misiniz?',
        trialexams_submit_confirm_unanswered: '{n} soruyu cevaplamadınız. Yine de gönderilsin mi?',
        notif_trialexam_paid_title: 'Deneme sınavı ödemeniz onaylandı',
        notif_trialexam_pending_title: 'Deneme sınavı kaydınız alındı',
        notif_trialexam_result_title: 'Deneme sınavı sonucunuz hazır',
        trialexams_correct_short: 'doğru',
        trialexams_wrong_short: 'yanlış',
        stat_unis: 'Seçilen üniversite',
        stat_docs: 'Tamamlanan belge',
        stat_consults: 'Planlanan danışmanlık',
        complete_profile: 'Profilini tamamla',
        complete_profile_sub: 'Ülke, bölüm, sınav sonuçları ve bütçeni gir ki sana uygun programları gösterelim.',
        fill_form: 'Formu doldur',
        selected_unis: 'Seçtiğiniz üniversiteler',
        about_us: 'Hakkımızda',
        unis_eyebrow: 'Arama',
        unis_title: 'Üniversiteler',
        unis_sub: 'Ülkeler ve bölümler profilinizdeki listeyle aynıdır — uygunluk profilinize göre hesaplanır.',
        uni_empty: 'Bu aramaya uygun üniversite bulunamadı.',
        all_countries: 'Hepsi',
        uni_filter_mine: 'Ülkelerim',
        pick_unis_title: 'Üniversite seçimini yap',
        pick_unis_sub: 'Seçtiğin ülke(ler)deki tüm üniversitelere bak ve sana uygun olanları seç.',
        pick_unis_btn: 'Üniversitelere bak',
        cmp_back: '← Üniversitelere dön',
        cmp_eyebrow: 'Karşılaştırma',
        cmp_title: 'Üniversiteleri karşılaştır',
        cmp_sub: 'Seçtiğiniz üniversiteler yan yana.',
        docs_eyebrow: 'Takip',
        docs_title: 'Belgelerim',
        docs_sub: 'Başvurunuz için gereken belgeler.',
        docs_progress: 'Genel ilerleme —',
        docs_note_label: 'Not:',
        docs_note: 'belgenin kağıt hâli yanınızdaysa telefonla fotoğrafını çekip doğrudan buraya yükleyebilirsiniz — tarayıcı gerekmez.',
        docs_empty: 'Belge listesi hazırlanıyor. Lütfen merkezle iletişime geçin.',
        doc_uploaded: 'Yüklendi',
        doc_approved: '✓ Onaylandı',
        doc_rejected: '❌ Reddedildi — yeniden yükle',
        doc_reupload: 'Yeniden yükle',
        doc_reason: 'Sebep',
        doc_delete_wrong: 'Yanlış dosyayı sil',
        upload: 'Yükle',
        consult_eyebrow: 'Destek',
        consult_title: 'Danışmanlık',
        consult_sub: 'Deneyimli danışmanlarla görüşme planlayın.',
        my_meetings: 'Görüşmeleriniz',
        advisors: 'Danışmanlar',
        book_meeting: 'Görüşme planla',
        meeting_type: 'Görüşme türü',
        type_online: 'Online',
        type_office: 'Yüz yüze (merkezde)',
        lbl_date: 'Tarih',
        lbl_time: 'Saat',
        confirm_meeting: 'Görüşmeyi onayla',
        cancel_meeting: 'İptal et',
        profile_edu: 'Eğitim profili',
        pr_level: 'Hedef derece',
        pr_field: 'Alan',
        pr_budget: 'Bütçe (yıllık)',
        pr_score: 'Sınav puanı',
        pr_countries: 'Hedef ülkeler',
        pr_next_consult: 'Yaklaşan danışmanlık',
        lang_section: 'Dil seçimi',
        edit_profile: 'Profili düzenle',
        logout: 'Çıkış yap',
        onb_back: '← Geri',
        onb_eyebrow: 'Profil',
        onb_title: 'Profiliniz',
        onb_sub: 'Bu bilgiler size uygun üniversite ve programları bulmak içindir.',
        onb_progress: 'Doldurulma —',
        onb_draft_note: '✓ Yazdıklarınız otomatik kaydedilir — yarım bıraksanız da kaybolmaz.',
        lbl_phone: 'Telefon numarası',
        q_countries: 'Hangi ülkelerde okumak istiyorsunuz? (en fazla 5)',
        q_universities: 'Hangi üniversitelerde okumak istiyorsunuz? (en fazla 5)',
        q_uni_hint: 'Önce yukarıdan ülke seçin.',
        q_custom_uni: 'Kendi üniversite seçiminiz (listede yoksa)',
        q_fields: 'Hangi bölümlerde okumak istiyorsunuz? (en fazla 5)',
        q_level: 'Seviye',
        lvl_bachelor: 'Lisans',
        lvl_master: 'Yüksek lisans',
        q_exams: 'Hangi sınav sonuçlarınız / sertifikalarınız var?',
        q_budget: 'Tahmini yıllık bütçeniz (öğrenim + yaşam)',
        budget_other: 'Diğer (kendin yaz)',
        budget_other_ph: 'örn. 5000 $ veya 10000 ₼',
        submit_profile: 'Profili tamamla',
        res_back: '← Formu düzenle',
        res_eyebrow: 'Profil hazır',
        res_title: 'Teşekkürler',
        res_sub: 'Profilinize göre sonraki adımlar bunlar.',
        res_summary: 'Profil özeti',
        r_name: 'Ad soyad', r_father_name: 'Baba adı', r_email: 'E-posta', r_phone: 'Telefon', r_country: 'Ülke',
        r_university: 'Üniversite', r_field: 'Bölüm', r_level: 'Seviye',
        r_exams: 'Sınav / sertifika', r_score: 'Puan', r_budget: 'Yıllık bütçe',
        next_step: 'Sonraki adım',
        contact_center: 'Bilik Eğitim Merkezi ile iletişim',
        contact_center_sub: 'Hangi programlara uygun olduğunuzu ve başvuru şartlarını danışmanla görüşmede netleştirebilirsiniz.',
        go_consult: 'Danışmanlığa kaydol',
        nav_home: 'Ana Sayfa', nav_form: 'Form doldur', nav_unis: 'Üniversiteler',
        nav_docs: 'Belgeler', nav_consult: 'Danışm.', nav_profile: 'Profil',
        notifications: 'Bildirimler',
        notif_announcement_title: 'Merkezden duyuru',
        notif_confirmed_title: 'Görüşmeniz onaylandı',
        notif_confirmed_tpl: '{date} tarihinde saat {time}\'de {advisor} ile görüşeceksiniz',
        parent_view_eyebrow: 'Veli görünümü',
        parent_view_loading: 'Yükleniyor...',
        parent_view_invalid_title: 'Bağlantı geçersiz',
        parent_view_invalid_sub: 'Bu bağlantı artık aktif değil veya iptal edildi. Merkezle iletişime geçin.',
        parent_view_docs: 'Belge ilerlemesi',
        parent_view_doc_tpl: '{done}/{total} belge hazır',
        parent_view_countries: 'Hedef ülkeler',
        parent_view_consult: 'Sonraki danışmanlık',
        parent_view_trialexams: 'Deneme sınavları',
        parent_view_footer: 'Bu, Bilik Eğitim Merkezi tarafından paylaşılan salt okunur bir görünümdür.',
        parent_view_none: 'Henüz seçilmedi',
        notif_reminder_title: 'Yaklaşan görüşme',
        notif_reminder_hours_tpl: '{hours} saat kaldı',
        notif_exam_title: 'Sınav sonucunuz eklendi',
        close: 'Kapat',
        // About us
        abt_center_desc: 'Bilik Eğitim Merkezi 2007 yılından bu yana Sumgayıt şehrinde faaliyet göstermektedir. Bugüne kadar yüzlerce öğrenci ve üniversite adayının başarı yolunda yanında olmuştur. Eğitimde kaliteye, sonuca ve güvene dayalı yaklaşımıyla, ailelerin ve gençlerin güvendiği köklü bir kurum haline gelmiştir. Bu nedenle 2011 yılından itibaren ikinci şubemiz Bakü\'de faaliyete başlamıştır. Bu yıllar boyunca yerel ve uluslararası eğitim alanlarında başarılı sonuçlar elde ederek onlarca öğrencinin üniversiteye ve yurt dışında eğitime kabulünü sağlamışızdır.',
        abt_mission_title: 'Misyonumuz',
        abt_mission_body: 'Eğitimi sadece sınava hazırlık olarak değil, hayata hazırlık olarak sunmak. Amacımız gençleri düşünen, öğrendiğini uygulayan ve geleceğe güvenle adım atan bireylere dönüştürmektir.',
        abt_services_title: 'Sunduğumuz hizmetler',
        abt_svc_1: 'Üniversite adayı hazırlığı (DİM, mezuniyet, kabul sınavları)',
        abt_svc_2: 'YÖS ve SAT sınavlarına hazırlık',
        abt_svc_3: 'Genel İngilizce kursları',
        abt_svc_4: 'Uluslararası sertifika sınavlarına hazırlık (TOEFL, IELTS, GRE, GMAT)',
        abt_svc_5: 'Matematik ve bilgisayar bilimi dersleri (olimpiyat hazırlığı dahil)',
        abt_svc_6: 'Yurt dışında eğitim danışmanlığı ve kayıt işlemleri',
        abt_svc_7: 'Yükseköğretim matematiği ve fizik dersleri (üniversite öğrencileri için)',
        abt_teachers_title: 'Öğretmen kadromuz',
        abt_teachers_body: 'Bilik Eğitim Merkezi\'nde yalnızca profesyonel, deneyimli ve uzman öğretmenler görev yapmaktadır. Her öğretmen kendi alanında modern öğretim yöntemlerini uygular ve her öğrenciye bireysel yaklaşım gösterir. Öğretmenlerimiz hem akademik bilgi hem de psikolojik yaklaşımla öğrenmeye motivasyon oluşturur.',
        abt_achieve_title: 'Başarılarımız',
        abt_achieve_1: '2007\'den bugüne kadar binlerce öğrenciye eğitim hizmeti verilmiştir',
        abt_achieve_2: 'Onlarca öğrencimiz yurt dışında eğitim almaktadır – Türkiye, Almanya, Polonya ve diğer ülkelerde',
        abt_achieve_3: 'Olimpiyatlarda ve deneme sınavlarında defalarca yüksek sonuçlar',
        abt_achieve_4: 'Ailelerin memnuniyeti ve tavsiyeleriyle sürekli büyüyen bir merkez',
        abt_why_title: 'Neden bizi seçiyorlar?',
        abt_why_1: '✅ 17 yıldan fazla deneyim – 2007\'den bugüne',
        abt_why_2: '✅ Kaliteli ve modern öğretim yaklaşımı',
        abt_why_3: '✅ Her öğrenciye özel program ve anlatım',
        abt_why_4: '✅ Gerçek sonuçlar, gerçek başarılar',
        abt_why_5: '✅ Sürekli destek ve yönlendirme',
        abt_why_6: '✅ Ailelerle düzenli iletişim ve raporlama',
        abt_closing_title: 'Başarıya giden yolun başlangıcı',
        abt_closing_body: 'Eğer siz de çocuğunuz için güvenli, modern ve sonuç odaklı bir eğitim merkezi arıyorsanız, Bilik Eğitim Merkezi doğru adres. Geleceğin üniversite öğrencileri, profesyonelleri ve liderleri burada yetişiyor.',
        abt_copyright: '© 2026 Bilik Eğitim Merkezi. Tüm hakları saklıdır.',
        achievements_title: 'Başarılarımız',
        achievements_empty: 'Henüz başarı eklenmedi.',
        services_empty: 'Henüz hizmet eklenmedi.',
        team_title: 'Ekibimiz',
        team_empty: 'Henüz ekip üyesi eklenmedi.',
        partner_unis_title: 'Ortak üniversiteler',
        partner_unis_empty: 'Henüz ortak üniversite eklenmedi.',
        news_title: 'Duyurular / Haberler',
        news_empty: 'Henüz haber eklenmedi.',
        ns_fill_profile_title: 'Profilini doldur',
        ns_fill_profile_sub: 'Sana uygun üniversiteleri gösterebilmemiz için ülke, bölüm ve bütçeni belirt.',
        ns_pick_unis_title: 'Üniversite seç',
        ns_pick_unis_sub: 'Profiline uygun üniversitelere bak ve ilgilendiklerini seç.',
        ns_first_doc_title: 'İlk belgeni yükle',
        ns_first_doc_sub: 'Başvurun için gereken belgeleri telefonla fotoğraflayıp yükleyebilirsin.',
        ns_docs_btn: 'Belgelere git',
        ns_docs_left_title_tpl: '{left} belge kaldı',
        ns_docs_left_sub_tpl: '{total} belgeden {done} tanesi hazır. Kalanları da yükle.',
        ns_consult_title: 'Danışmanlık al',
        ns_consult_sub: 'Belgelerin hazır. Şimdi danışmanla görüşme planla.',
        ns_consult_btn: 'Görüşme planla',
        ns_done_title: 'Her şey yolunda',
        ns_done_sub: 'Profilin, belgelerin ve görüşmen hazır. Sonraki adımları danışmanın sana söyleyecek.',
        ns_done_btn: 'Görüşmelerime bak',
        ns_docs_chip_tpl: 'Belgeler {done}/{total}',
        ns_deadline_overdue_tpl: '{name} — süresi geçti',
        ns_deadline_today_tpl: '{name} — son gün',
        ns_deadline_days_tpl: '{name} — {days} gün kaldı'
      }
    };


    let currentLang = 'az';
    try {
      currentLang = window.localStorage.getItem('btm_lang') || 'az';
    } catch (e) {
      console.warn('localStorage read error:', e);
    }

    /* JS ilə yaradılan mətnlər üçün tərcümə köməkçisi.
       (HTML-dəki sabit mətnlər data-i18n atributu ilə tərcümə olunur.)
       try/catch lazımdır: bəzi funksiyalar (məs. renderDocList) skript
       yüklənərkən `translations`/`currentLang` təyin olunmamışdan əvvəl
       işə düşür — belə halda sadəcə Azərbaycanca ehtiyat mətn qaytarılır,
       dil seçildikdən sonra applyLanguage onları yenidən render edir. */
    function t(key, fallback = '') {
      try {
        return (translations[currentLang] && translations[currentLang][key])
          || (translations.az && translations.az[key])
          || fallback;
      } catch (e) {
        return fallback;
      }
    }

    function applyLanguage(lang) {
      if (!lang) return;
      currentLang = lang;

      try {
        window.localStorage.setItem('btm_lang', lang);
      } catch (e) {
        console.warn('localStorage write error:', e);
      }

      const t = translations[lang];
      if (!t) return;

      try {
        // Mətn məzmunu — təhlükəsizlik üçün textContent (innerHTML deyil)
        document.querySelectorAll('[data-i18n]').forEach(el => {
          const key = el.getAttribute('data-i18n');
          if (key && t[key]) el.textContent = t[key];
        });
        // Yer tutucu (placeholder) mətnləri
        document.querySelectorAll('[data-i18n-ph]').forEach(el => {
          const key = el.getAttribute('data-i18n-ph');
          if (key && t[key]) el.setAttribute('placeholder', t[key]);
        });
        // <option> mətnləri
        document.querySelectorAll('option[data-i18n-opt]').forEach(el => {
          const key = el.getAttribute('data-i18n-opt');
          if (key && t[key]) el.textContent = t[key];
        });
        // Dinamik render olunan hissələri yeni dildə yenidən qur
        if (typeof renderUniFilters === 'function') renderUniFilters();
        if (typeof renderUniCatalog === 'function') renderUniCatalog();
        if (typeof renderDocList === 'function') renderDocList();
        if (typeof updateNextStepCard === 'function') updateNextStepCard();
      } catch (e) {
        console.error('Error translating elements:', e);
      }

      try {
        if (t.page_title) {
          document.title = t.page_title;
        }
      } catch (e) { }

      try {
        // Update language button styles safely
        const btns = document.querySelectorAll('.lang-btn');
        for (let i = 0; i < btns.length; i++) {
          const btn = btns[i];
          const btnLang = btn.getAttribute('data-lang');
          if (btnLang === lang) {
            btn.style.background = 'var(--navy)';
            btn.style.color = 'var(--gold)';
            btn.style.borderColor = 'var(--navy)';
            btn.classList.add('active');
          } else {
            btn.style.background = '#fff';
            btn.style.color = 'var(--ink-soft)';
            btn.style.borderColor = 'var(--line)';
            btn.classList.remove('active');
          }
        }
      } catch (e) {
        console.error('Error updating button styles:', e);
      }
    }

    // Language button click handlers safely
    try {
      const langBtns = document.querySelectorAll('.lang-btn');
      for (let i = 0; i < langBtns.length; i++) {
        const btn = langBtns[i];
        btn.addEventListener('click', function () {
          const lang = this.getAttribute('data-lang');
          applyLanguage(lang);

          try {
            toast(lang === 'az' ? '✓ Dil dəyişdirildi' :
              lang === 'en' ? '✓ Language changed' :
                lang === 'ru' ? '✓ Язык изменён' :
                  '✓ Dil değiştirildi');
          } catch (e) {
            console.error('Toast error:', e);
          }
        });
      }
    } catch (e) {
      console.error('Error attaching lang events:', e);
    }

    // Apply saved language on load
    if (currentLang && currentLang !== 'az') {
      applyLanguage(currentLang);
    }

    /* ═══════════════════════════════════════════════════════════
       ADMIN PANELİ — TAM MƏNTİQ
    ═══════════════════════════════════════════════════════════ */

    // ── Konfiqurasiya ──────────────────────────────────────────
    // QEYD: Supabase-də `profiles` cədvəlinə `role` sütunu əlavə edin:
    // ALTER TABLE profiles ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'student';
    // ALTER TABLE profiles ADD COLUMN IF NOT EXISTS student_status TEXT DEFAULT 'active';
    // ALTER TABLE consultations ADD COLUMN IF NOT EXISTS confirmed BOOLEAN DEFAULT false;
    //
    // Supabase-də admin rollarını vermək üçün (bir dəfə icra edin):
    // UPDATE profiles SET role = 'admin' WHERE email IN ('rovshen.a@gmail.com', 'abdulhasanlie@gmail.com');
    const ADMIN_EMAILS = [
      'rovshen.a@gmail.com',      // Rovşən bəy — Müdür
      'abdulhasanlie@gmail.com'   // Abdul Həsənli — Developer
    ];

    let currentAdminRole = null; // 'admin' | 'staff' | null
    let allStudentsCache = [];   // Tələbə siyahısını cache-də saxla
    let staffToDelete = null;    // Silinəcək işçinin emaili
    let lastAppointmentsData = []; // CSV export üçün son yüklənmiş görüşlər
    let lastDocumentsData = [];    // CSV export üçün son yüklənmiş sənədlər

    // ── CSV İxrac ───────────────────────────────────────────────
    function downloadCSV(filename, headers, rows) {
      const esc = (val) => '"' + String(val ?? '').replace(/"/g, '""') + '"';
      const csv = [headers.map(esc).join(','), ...rows.map(r => r.map(esc).join(','))].join('\r\n');
      const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    }

    // ── Köməkçi: Modal aç/bağla ───────────────────────────────
    function openModal(id) {
      document.getElementById(id).classList.add('open');
    }
    function closeModal(id) {
      document.getElementById(id).classList.remove('open');
    }

    // ── Rol Yoxlama ────────────────────────────────────────────
    async function checkUserRole(email) {
      if (!email) return 'student';
      // 1. Şeil: Həmişə admin olan emailləri yoxla (Supabase olmasa belə)
      if (ADMIN_EMAILS.includes(email.toLowerCase().trim())) return 'admin';
      // 2. Şeil: Supabase-dən rolu oxu
      if (!sb) return 'student';
      const { data, error } = await sb.from('profiles')
        .select('role')
        .eq('email', email)
        .limit(1);
      if (error || !data || !data.length) return 'student';
      return data[0].role || 'student';
    }


    // ── Admin Ekrana keç ───────────────────────────────────────
    async function enterAdminPanel(role) {
      currentAdminRole = role;
      document.getElementById('navbar').style.display = 'none';
      document.getElementById('admin-role-badge').textContent =
        role === 'admin' ? 'Admin' : 'İşçi';

      // Staff-a yalnız admin-ə aid sətirləri "Daha" menyusundan gizlə — İşçilər,
      // Qeydiyyat (audit), Sənəd şablonları, Elan göndər. Universitetlər, Əməkdaşlarımız,
      // Əməkdaş universitetlər və Xidmətlərimiz staff-a da açıqdır (gündəlik iş sayılır).
      const adminOnlyRowIds = ['admin-more-staff', 'admin-more-audit', 'admin-more-doctemplates', 'admin-more-announce'];
      adminOnlyRowIds.forEach(id => {
        const row = document.getElementById(id);
        if (row) row.style.display = (role === 'admin') ? '' : 'none';
      });

      showScreen('admin');
      updateAdminReturnFab();
      await loadAdminDashboard();
      subscribeAdminRealtime();
    }

    // ── Admin/işçi tələbə görünüşünə keçid ("Tələbə kimi bax") ──
    // Admin öz hesabı ilə tələbənin gördüyünü yoxlaya bilsin, sonra bir
    // toxunuşla panelə qayıda bilsin.
    async function viewAsStudent() {
      document.getElementById('navbar').style.display = 'flex';
      navBtns.forEach(b => b.classList.remove('active'));
      document.querySelector('[data-target="home"]')?.classList.add('active');
      showScreen('home');
      fetchDocumentsStatus(currentEmail);
      if (typeof restoreProfile === 'function') await restoreProfile(currentEmail);
      if (typeof loadMyConsultations === 'function') loadMyConsultations(); else refreshNotifBadge();
      updateAdminReturnFab();
    }

    function updateAdminReturnFab() {
      const banner = document.getElementById('admin-return-banner');
      if (!banner) return;
      const onAdminScreen = document.getElementById('admin').classList.contains('active');
      banner.classList.toggle('show', !!currentAdminRole && !onAdminScreen);
    }

    document.getElementById('admin-more-view-as-student')?.addEventListener('click', () => {
      closeModal('admin-more-modal');
      viewAsStudent();
    });

    // ── Bütün tələbələrə elan göndər ────────────────────────────
    document.getElementById('admin-more-announce')?.addEventListener('click', () => {
      closeModal('admin-more-modal');
      document.getElementById('announce-text').value = '';
      openModal('announce-modal');
    });
    document.getElementById('announce-cancel-btn')?.addEventListener('click', () => closeModal('announce-modal'));
    document.getElementById('announce-modal')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeModal('announce-modal');
    });
    document.getElementById('announce-send-btn')?.addEventListener('click', async () => {
      const text = document.getElementById('announce-text').value.trim();
      if (!text) { toast('Mesaj yazın', true); return; }
      if (!sb) return;
      if (!confirm('Bu mesaj bütün tələbələrə göndəriləcək. Davam edilsin?')) return;
      const btn = document.getElementById('announce-send-btn');
      btn.disabled = true; btn.textContent = 'Göndərilir...';
      const { error } = await sb.from('announcements').insert({ message: text, created_by: currentEmail });
      btn.disabled = false; btn.textContent = 'Göndər';
      if (error) { toast('Xəta: ' + error.message, true); return; }
      logAudit('Elan göndərildi', '', text.slice(0, 80));
      toast('✓ Elan bütün tələbələrə göndərildi');
      closeModal('announce-modal');
    });
    document.getElementById('admin-return-btn')?.addEventListener('click', () => {
      if (currentAdminRole) enterAdminPanel(currentAdminRole);
    });

    // ── Fəaliyyət qeydi (audit log) ────────────────────────────
    async function logAudit(action, target = '', detail = '') {
      if (!sb || !currentEmail) return;
      await sb.from('audit_log').insert({
        actor_email: currentEmail, action, target, detail
      });
    }

    async function loadAuditLog() {
      const listEl = document.getElementById('admin-audit-list');
      if (!listEl) return;
      listEl.innerHTML = '<div class="skeleton-card"><div class="skeleton skeleton-line wide"></div><div class="skeleton skeleton-line narrow"></div></div>'.repeat(4);

      if (!sb) { listEl.innerHTML = '<div class="admin-empty"><span class="empty-icon">⚠️</span>Supabase bağlantısı yoxdur.</div>'; return; }

      const { data, error } = await sb.from('audit_log')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100);

      if (error) {
        listEl.innerHTML = `
          <div class="admin-empty" style="text-align:left; padding:16px;">
            <span class="empty-icon">❌</span>
            <b>Xəta:</b> ${error.message}<br><br>
            <span style="font-size:11px; color:var(--ink-soft);">"audit_log" cədvəli hələ yaradılmayıb ola bilər — bax: supabase-security-setup.sql</span>
          </div>`;
        return;
      }
      if (!data || !data.length) {
        listEl.innerHTML = '<div class="admin-empty"><span class="empty-icon">🧾</span>Hələ heç bir fəaliyyət qeydə alınmayıb.</div>';
        return;
      }

      const card = document.createElement('div');
      card.className = 'admin-card';
      data.forEach(entry => {
        const row = document.createElement('div');
        row.className = 'admin-card-row';
        const when = entry.created_at ? new Date(entry.created_at).toLocaleString('az-AZ') : '—';
        row.innerHTML = `
          <div class="admin-card-row-info">
            <p class="admin-row-name">${escapeHtml(entry.action)}${entry.target ? ' — ' + escapeHtml(entry.target) : ''}</p>
            <p class="admin-row-sub">${escapeHtml(entry.actor_email) || '—'} · ${when}${entry.detail ? ' · ' + escapeHtml(entry.detail) : ''}</p>
          </div>`;
        card.appendChild(row);
      });
      listEl.innerHTML = '';
      listEl.appendChild(card);
    }

    // ── Real-time yeniləmə ──────────────────────────────────────
    // Admin panelindəykən başqa istifadəçi/tələbə məlumat dəyişdirsə,
    // hazırkı aktiv tab avtomatik yenilənir (səhifəni əl ilə yeniləmək lazım deyil).
    let adminRealtimeChannel = null;
    function subscribeAdminRealtime() {
      if (!sb || adminRealtimeChannel) return;
      const refreshActiveTab = () => {
        if (currentAdminTab === 'dashboard') loadAdminDashboard();
        else if (currentAdminTab === 'students') loadStudents();
        else if (currentAdminTab === 'appointments') loadAppointments(document.getElementById('appt-filter')?.value || 'all');
        else if (currentAdminTab === 'documents') loadAdminDocuments(document.getElementById('doc-name-filter')?.value.trim() || '');
        else if (currentAdminTab === 'staff') loadStaff();
        else if (currentAdminTab === 'audit') loadAuditLog();
      };
      adminRealtimeChannel = sb.channel('admin-live-updates')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, refreshActiveTab)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'consultations' }, refreshActiveTab)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'document_status' }, refreshActiveTab)
        .subscribe();
    }

    // ── Dashboard ──────────────────────────────────────────────
    async function loadAdminDashboard() {
      if (!sb) { renderDashboardOffline(); return; }

      // Bütün profilləri bir sorğuda çək — role sütunu olmasa belə işləyir
      const { data: allProfiles, error: profErr } = await sb.from('profiles')
        .select('name, email, created_at, role');

      let totalStudents = 0, newStudents = 0;
      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 7);

      if (!profErr && allProfiles) {
        const students = allProfiles.filter(p =>
          !ADMIN_EMAILS.includes((p.email || '').toLowerCase()) &&
          p.role !== 'admin' && p.role !== 'staff'
        );
        totalStudents = students.length;
        newStudents = students.filter(p =>
          p.created_at && new Date(p.created_at) >= weekAgo
        ).length;
      }

      // Konsultasiya sayı
      const { count: apptCount } = await sb.from('consultations')
        .select('*', { count: 'exact', head: true });

      // Sənəd sayı
      const { count: docsCount } = await sb.from('document_status')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'done');

      document.getElementById('dash-total-students').textContent = totalStudents;
      document.getElementById('dash-new-students').textContent = newStudents;
      document.getElementById('dash-appointments').textContent = apptCount || 0;
      document.getElementById('dash-docs').textContent = docsCount || 0;

      // Son 5 qeydiyyat
      const recentList = document.getElementById('dash-recent-list');
      if (!allProfiles || !allProfiles.length) {
        recentList.innerHTML = '<div class="admin-empty"><span class="empty-icon">📭</span>Hələ qeydiyyat yoxdur.</div>';
        return;
      }
      const recent = [...allProfiles]
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .slice(0, 5);

      recentList.innerHTML = recent.map(s => {
        const isAdmin = ADMIN_EMAILS.includes((s.email || '').toLowerCase()) || s.role === 'admin';
        const isStaff = s.role === 'staff';
        const badge = isAdmin ? 'admin-role' : isStaff ? 'staff' : 'active';
        const label = isAdmin ? 'Admin' : isStaff ? 'İşçi' : 'Tələbə';
        const date = s.created_at ? new Date(s.created_at).toLocaleDateString('az-AZ') : '—';
        return `
        <div class="admin-card-row" style="background:#fff; border-radius:12px; margin-bottom:8px; box-shadow:0 1px 4px rgba(15,23,42,0.06);">
          <div class="admin-card-row-info">
            <p class="admin-row-name">${escapeHtml(s.name) || 'Ad yoxdur'}</p>
            <p class="admin-row-sub">${escapeHtml(s.email) || '—'} · ${date}</p>
          </div>
          <span class="status-badge ${badge}">${label}</span>
        </div>`;
      }).join('');
    }

    function renderDashboardOffline() {
      ['dash-total-students', 'dash-new-students', 'dash-appointments', 'dash-docs']
        .forEach(id => document.getElementById(id).textContent = '—');
      document.getElementById('dash-recent-list').innerHTML =
        '<div class="admin-empty"><span class="empty-icon">⚠️</span>Supabase bağlantısı yoxdur.</div>';
    }

    // ── Tələbələr ─────────────────────────────────────────────
    async function loadStudents() {
      const listEl = document.getElementById('admin-students-list');
      listEl.innerHTML = '<div class="skeleton-card"><div class="skeleton skeleton-line wide"></div><div class="skeleton skeleton-line narrow"></div></div>'.repeat(3);

      if (!sb) {
        listEl.innerHTML = '<div class="admin-empty"><span class="empty-icon">⚠️</span>Supabase bağlantısı yoxdur.</div>';
        return;
      }

      const { data, error } = await sb.from('profiles')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) {
        listEl.innerHTML = `
          <div class="admin-empty" style="text-align:left; padding:16px;">
            <span class="empty-icon">❌</span>
            <b>Məlumat yüklənmədi</b><br>
            <span style="font-size:12px; color:var(--ink-soft);">${escapeHtml(error.message)}</span><br><br>
            <span style="font-size:11px; color:var(--ink-soft);">Bu, baza icazələri (RLS) ilə bağlı ola bilər — layihədəki
            <b>supabase-security-setup.sql</b> faylını Supabase → SQL Editor-da icra edin.</span>
            <button class="admin-action-btn" id="students-retry-btn" style="margin-top:12px;">🔄 Yenidən yoxla</button>
          </div>`;
        document.getElementById('students-retry-btn')?.addEventListener('click', loadStudents);
        return;
      }

      // Bütün data gəldi — JS-də admin/staff-i filtr et
      allStudentsCache = (data || []).filter(s =>
        !ADMIN_EMAILS.includes((s.email || '').toLowerCase()) &&
        s.role !== 'admin' && s.role !== 'staff'
      );

      // Tələbə sayını başlıqda göstər
      const titleEl = document.querySelector('#admin-panel-students .admin-section-title');
      if (titleEl) titleEl.textContent = `Bütün tələbələr (${allStudentsCache.length})`;

      renderStudentList(allStudentsCache);
    }

    function renderStudentList(students) {
      const listEl = document.getElementById('admin-students-list');
      if (!students.length) {
        // Axtarış aktivdirsə "tapılmadı", əks halda sadəcə hələ qeydiyyat yoxdur
        const searching = !!document.getElementById('student-search')?.value.trim();
        listEl.innerHTML = searching
          ? '<div class="admin-empty"><span class="empty-icon">🔍</span>Axtarışa uyğun tələbə tapılmadı.</div>'
          : '<div class="admin-empty"><span class="empty-icon">👥</span>Hələ tələbə qeydiyyatı yoxdur.</div>';
        return;
      }

      listEl.innerHTML = '';
      const card = document.createElement('div');
      card.className = 'admin-card';

      students.forEach(s => {
        const status = s.student_status || 'active';
        const row = document.createElement('div');
        row.className = 'admin-card-row';
        row.innerHTML = `
          <div class="admin-card-row-info" style="cursor:pointer;" data-email="${escapeHtml(s.email)}">
            <p class="admin-row-name">${escapeHtml(s.name) || 'Ad yoxdur'}</p>
            <p class="admin-row-sub">${escapeHtml(s.email) || '—'} · ${escapeHtml(s.target_countries ? (Array.isArray(s.target_countries) ? s.target_countries[0] : s.target_countries) : '') || '—'}</p>
          </div>
          <div style="display:flex; gap:6px; align-items:center; flex-shrink:0;">
            <select class="status-select student-status-sel" data-email="${escapeHtml(s.email)}">
              <option value="active" ${status === 'active' ? 'selected' : ''}>Aktiv</option>
              <option value="pending" ${status === 'pending' ? 'selected' : ''}>Gözləmədə</option>
              <option value="done" ${status === 'done' ? 'selected' : ''}>Tamamlandı</option>
            </select>
          </div>`;
        card.appendChild(row);

        // Modal aç — tələbə adına klik
        row.querySelector('.admin-card-row-info').addEventListener('click', () => openStudentModal(s));
        // Status dəyiş
        row.querySelector('.student-status-sel').addEventListener('change', async (e) => {
          await updateStudentStatus(s.email, e.target.value);
          toast('✓ Status yeniləndi');
        });
      });

      listEl.appendChild(card);
    }

    async function updateStudentStatus(email, status) {
      if (!sb) return;
      await sb.from('profiles').update({ student_status: status }).eq('email', email);
      logAudit('Status dəyişdirildi', email, status);
    }

    // ── Tələbə Modalı ─────────────────────────────────────────
    function openStudentModal(student) {
      document.getElementById('modal-student-name').textContent = student.name || 'Ad yoxdur';
      document.getElementById('modal-email-link').href = 'mailto:' + (student.email || '');

      const rows = [
        ['Ata adı', student.father_name || '—'],
        ['Email', student.email || '—'],
        ['Telefon', student.phone || '—'],
        ['Hədəf ölkə', Array.isArray(student.target_countries) ? student.target_countries.join(', ') : (student.target_countries || '—')],
        ['Universitet', Array.isArray(student.target_universities) ? student.target_universities.join(', ') : (student.target_universities || '—')],
        ['İxtisas', Array.isArray(student.fields) ? student.fields.join(', ') : (student.fields || '—')],
        ['Səviyyə', student.level || '—'],
        ['İmtahan', student.exams ? (Array.isArray(student.exams) ? student.exams.join(', ') : student.exams) : '—'],
        ['Bal', student.score || '—'],
        ['Büdcə', student.budget || '—'],
        ['Qeydiyyat', student.created_at ? new Date(student.created_at).toLocaleDateString('az-AZ') : '—'],
        ['Status', student.student_status || 'active'],
      ];

      document.getElementById('modal-student-body').innerHTML = rows
        .map(([k, v]) => `<div class="admin-modal-row"><span>${k}</span><span>${escapeHtml(v)}</span></div>`)
        .join('');

      // Çap / PDF — brauzerin öz "PDF kimi saxla" pəncərəsini açır
      document.getElementById('modal-print-btn').onclick = () => printStudentProfile(student, rows);

      // Valideyn üçün girişsiz, yalnız-oxu link yaradır
      document.getElementById('modal-parent-link-btn').onclick = async () => {
        if (!sb || !student.email) return;
        const btn = document.getElementById('modal-parent-link-btn');
        btn.disabled = true; btn.textContent = 'Yaradılır...';
        const { data, error } = await sb.from('parent_links')
          .insert({ student_email: student.email, created_by: currentEmail })
          .select().single();
        btn.disabled = false; btn.textContent = '🔗 Valideyn linki yarat';
        if (error) { toast('Xəta: ' + error.message, true); return; }
        const link = PRODUCTION_URL.replace(/\/$/, '') + '/?parent=' + data.token;
        logAudit('Valideyn linki yaradıldı', student.email);
        try { await navigator.clipboard.writeText(link); toast('✓ Link kopyalandı'); } catch (e) { /* clipboard əlçatmazdırsa səssizcə keç */ }
        window.prompt('Valideynə göndəriləcək link (kopyalanıb, lazım olsa buradan da götürün):', link);
      };

      openModal('student-modal');
    }

    /* Tələbə profilini çap/PDF üçün hazırlayır. Xarici PDF kitabxanası
       istifadə olunmur — CSP xarici skriptləri bloklayır və brauzerin öz
       "PDF kimi saxla" imkanı bu məqsəd üçün kifayətdir. */
    function printStudentProfile(student, rows) {
      const area = document.getElementById('print-area');
      if (!area) return;
      const printedAt = new Date().toLocaleString('az-AZ');
      area.innerHTML = `
        <div class="p-head">
          <p class="p-brand">Bilik Tədris Mərkəzi</p>
          <p class="p-sub">Tələbə profili · Xaricdə təhsil</p>
        </div>
        <h2>${escapeHtml(student.name || 'Ad yoxdur')}</h2>
        <table>
          ${rows.map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join('')}
        </table>
        <p class="p-foot">Çap tarixi: ${escapeHtml(printedAt)} · Hazırlayan: ${escapeHtml(currentEmail || '—')}</p>`;
      logAudit('Tələbə profili çap edildi', student.email || '');
      window.print();
    }

    // ── Konsultasiyalar ───────────────────────────────────────
    // `status` sütunu yoxdursa (köhnə sətirlər) köhnə `confirmed` boolean-a geri qayıdır.
    function apptStatusMeta(appt) {
      const status = appt.status || (appt.confirmed ? 'confirmed' : 'pending');
      if (status === 'confirmed') return { label: 'Təsdiqləndi', cls: 'done', status };
      if (status === 'rejected') return { label: 'Rədd edildi', cls: 'rejected', status };
      return { label: 'Gözləyir', cls: 'pending', status: 'pending' };
    }

    async function loadAppointments(filterAdvisor = 'all') {
      const listEl = document.getElementById('admin-appointments-list');
      listEl.innerHTML = '<div class="skeleton-card"><div class="skeleton skeleton-line wide"></div><div class="skeleton skeleton-line narrow"></div></div>'.repeat(3);

      if (!sb) { listEl.innerHTML = '<div class="admin-empty"><span class="empty-icon">⚠️</span>Supabase bağlantısı yoxdur.</div>'; return; }

      const dateFrom = document.getElementById('appt-date-from')?.value;
      const dateTo = document.getElementById('appt-date-to')?.value;

      let query = sb.from('consultations').select('*').order('created_at', { ascending: false });
      // advisor_name bazada "Fərid Bəy (Online)" kimi növ ilə saxlanılır, ona görə
      // filtr adı ilə başlayan bütün sətirləri tuturuq (tam uyğunluq deyil).
      if (filterAdvisor !== 'all') query = query.ilike('advisor_name', filterAdvisor + '%');
      if (dateFrom) query = query.gte('date', dateFrom);
      if (dateTo) query = query.lte('date', dateTo);

      const { data, error } = await query;

      if (error || !data) {
        listEl.innerHTML = '<div class="admin-empty"><span class="empty-icon">❌</span>Məlumat yüklənmədi.</div>';
        return;
      }
      lastAppointmentsData = data;
      if (!data.length) {
        listEl.innerHTML = '<div class="admin-empty"><span class="empty-icon">📅</span>Görüş tapılmadı.</div>';
        return;
      }

      const card = document.createElement('div');
      card.className = 'admin-card';
      data.forEach(appt => {
        const row = document.createElement('div');
        row.className = 'admin-card-row';
        const meta = apptStatusMeta(appt);
        row.innerHTML = `
          <div class="admin-card-row-info" style="cursor:pointer;">
            <p class="admin-row-name">${escapeHtml(appt.profile_email) || '—'}</p>
            <p class="admin-row-sub">${escapeHtml(appt.advisor_name) || '—'} · ${escapeHtml(appt.date) || '—'} saat ${escapeHtml(appt.time) || '—'}</p>
          </div>
          <span class="status-badge ${meta.cls}">${meta.label}</span>`;
        row.querySelector('.admin-card-row-info').addEventListener('click', () => openApptModal(appt));
        card.appendChild(row);
      });

      listEl.innerHTML = '';
      listEl.appendChild(card);
    }

    function openApptModal(appt) {
      const meta = apptStatusMeta(appt);
      document.getElementById('modal-appt-title').textContent = appt.profile_email || 'Görüş';
      const rows = [
        ['Tələbə', appt.profile_email || '—'],
        ['Məsləhətçi', appt.advisor_name || '—'],
        ['Tarix', appt.date || '—'],
        ['Saat', appt.time || '—'],
        ['Status', meta.label],
        ['Yaradılıb', appt.created_at ? new Date(appt.created_at).toLocaleDateString('az-AZ') : '—'],
      ];
      if (meta.status === 'rejected' && appt.admin_note) {
        rows.push(['Tələbəyə təklif', appt.admin_note]);
      }
      document.getElementById('modal-appt-body').innerHTML = rows
        .map(([k, v]) => `<div class="admin-modal-row"><span>${k}</span><span>${escapeHtml(v)}</span></div>`)
        .join('');

      // Rədd formunu bağla, əsas düymələri göstər
      const actionsRow = document.getElementById('appt-modal-actions');
      const rejectForm = document.getElementById('appt-reject-form');
      const rejectActions = document.getElementById('appt-reject-actions');
      const rejectNoteInput = document.getElementById('appt-reject-note');
      actionsRow.style.display = 'flex';
      rejectForm.style.display = 'none';
      rejectActions.style.display = 'none';
      rejectNoteInput.value = '';

      const confirmBtn = document.getElementById('appt-modal-confirm-btn');
      confirmBtn.onclick = async () => {
        if (!sb) return;
        await sb.from('consultations').update({ status: 'confirmed', confirmed: true }).eq('id', appt.id);
        logAudit('Görüş təsdiqləndi', appt.profile_email, appt.advisor_name);
        toast('✓ Görüş təsdiqləndi!');
        closeModal('appt-modal');
        loadAppointments(document.getElementById('appt-filter').value);
      };

      const rejectBtn = document.getElementById('appt-modal-reject-btn');
      rejectBtn.onclick = () => {
        actionsRow.style.display = 'none';
        rejectForm.style.display = 'block';
        rejectActions.style.display = 'flex';
        rejectNoteInput.focus();
      };

      document.getElementById('appt-reject-cancel-btn').onclick = () => {
        actionsRow.style.display = 'flex';
        rejectForm.style.display = 'none';
        rejectActions.style.display = 'none';
      };

      document.getElementById('appt-reject-send-btn').onclick = async () => {
        const note = rejectNoteInput.value.trim();
        if (!note) { toast('Zəhmət olmasa alternativ təklif yazın', true); rejectNoteInput.focus(); return; }
        if (!sb) return;
        await sb.from('consultations').update({ status: 'rejected', confirmed: false, admin_note: note }).eq('id', appt.id);
        logAudit('Görüş rədd edildi', appt.profile_email, note);
        toast('✓ Rədd edildi, tələbəyə təklif göndərildi');
        closeModal('appt-modal');
        loadAppointments(document.getElementById('appt-filter').value);
      };

      openModal('appt-modal');
    }

    // ── Sənədlər ─────────────────────────────────────────────
    // Profil ad→email xəritəsi cache
    let profilesNameCache = null;
    async function loadProfilesCache() {
      if (profilesNameCache || !sb) return;
      const { data } = await sb.from('profiles').select('email, name');
      profilesNameCache = {};
      (data || []).forEach(p => { profilesNameCache[p.email] = p.name || ''; });
    }

    // Sənəd statusuna görə etiket/rəng — 'done' hələ baxılmayıb (yükləndi, gözləyir),
    // 'approved' admin təsdiqləyib, 'rejected' admin rədd edib (tələbə yenidən yükləyəcək).
    function docStatusMeta(status) {
      if (status === 'approved') return { label: 'Təsdiqləndi', cls: 'done' };
      if (status === 'rejected') return { label: 'Rədd edildi', cls: 'rejected' };
      return { label: 'Yoxlanılır', cls: 'pending' };
    }

    let selectedDocIds = new Set();

    function updateDocsBulkBar() {
      const bar = document.getElementById('admin-docs-bulk-bar');
      const countEl = document.getElementById('admin-docs-bulk-count');
      if (!bar) return;
      if (selectedDocIds.size) {
        bar.style.display = 'flex';
        countEl.textContent = `${selectedDocIds.size} sənəd seçilib`;
      } else {
        bar.style.display = 'none';
      }
    }

    async function approveDocuments(ids) {
      if (!sb || !ids.length) return;
      const { error } = await sb.from('document_status').update({ status: 'approved', rejection_note: null }).in('id', ids);
      if (error) { toast('Xəta: ' + error.message, true); return; }
      logAudit('Sənəd(lər) təsdiqləndi', '', ids.length + ' sənəd');
      toast('✓ Təsdiqləndi');
      selectedDocIds.clear();
      loadAdminDocuments(document.getElementById('doc-name-filter')?.value.trim() || '');
    }

    async function rejectDocuments(ids) {
      if (!sb || !ids.length) return;
      const reason = prompt(ids.length > 1 ? `${ids.length} sənədi rədd etmək üçün səbəb yazın:` : 'Rədd səbəbini yazın (tələbə bunu görəcək):');
      if (reason === null) return;
      if (!reason.trim()) { toast('Səbəb yazmalısınız', true); return; }
      const { error } = await sb.from('document_status').update({ status: 'rejected', rejection_note: reason.trim() }).in('id', ids);
      if (error) { toast('Xəta: ' + error.message, true); return; }
      logAudit('Sənəd(lər) rədd edildi', '', reason.trim());
      toast('✓ Rədd edildi, tələbəyə göstəriləcək');
      selectedDocIds.clear();
      loadAdminDocuments(document.getElementById('doc-name-filter')?.value.trim() || '');
    }

    document.getElementById('admin-docs-bulk-approve')?.addEventListener('click', () => approveDocuments([...selectedDocIds]));
    document.getElementById('admin-docs-bulk-reject')?.addEventListener('click', () => rejectDocuments([...selectedDocIds]));

    async function loadAdminDocuments(nameFilter = '') {
      const listEl = document.getElementById('admin-documents-list');
      listEl.innerHTML = '<div class="skeleton-card"><div class="skeleton skeleton-line wide"></div><div class="skeleton skeleton-line narrow"></div></div>'.repeat(4);
      selectedDocIds.clear();
      updateDocsBulkBar();

      if (!sb) {
        listEl.innerHTML = '<div class="admin-empty"><span class="empty-icon">⚠️</span>Supabase bağlantısı yoxdur.</div>';
        return;
      }

      // Profil adlarını yüklə (cache)
      await loadProfilesCache();

      // Ada görə uyğun emailləri tap
      let allowedEmails = null;
      if (nameFilter) {
        const q = nameFilter.toLowerCase();
        allowedEmails = Object.entries(profilesNameCache || {})
          .filter(([email, name]) =>
            name.toLowerCase().includes(q) ||
            email.toLowerCase().includes(q)
          )
          .map(([email]) => email);

        if (!allowedEmails.length) {
          listEl.innerHTML = '<div class="admin-empty"><span class="empty-icon">👤</span>Bu ada uyğun tələbə tapılmadı.</div>';
          return;
        }
      }

      // Yüklənmiş sənədləri çək (yoxlanılır / təsdiqlənib / rədd edilib — hamısı)
      let query = sb.from('document_status')
        .select('*')
        .in('status', ['done', 'approved', 'rejected'])
        .order('uploaded_at', { ascending: false })
        .limit(200);

      if (allowedEmails && allowedEmails.length === 1) {
        query = query.eq('profile_email', allowedEmails[0]);
      } else if (allowedEmails && allowedEmails.length > 1) {
        query = query.in('profile_email', allowedEmails);
      }

      const { data, error } = await query;

      if (error) {
        listEl.innerHTML = `<div class="admin-empty"><span class="empty-icon">❌</span>Xəta: ${error.message}</div>`;
        return;
      }
      if (!data || !data.length) {
        listEl.innerHTML = '<div class="admin-empty"><span class="empty-icon">📁</span>Yüklənmiş sənəd tapılmadı.</div>';
        lastDocumentsData = [];
        return;
      }
      lastDocumentsData = data;

      // Bucket private ola bilər — hər sənəd üçün müvəqqəti (1 saatlıq) baxış linki yaradırıq
      await Promise.all(data.map(async doc => {
        doc._viewUrl = await getSignedDocUrl(doc.file_url);
      }));

      // Tələbəyə görə qruplaşdır
      const grouped = {};
      data.forEach(doc => {
        const email = doc.profile_email || 'naməlum';
        if (!grouped[email]) grouped[email] = [];
        grouped[email].push(doc);
      });

      listEl.innerHTML = '';

      Object.entries(grouped).forEach(([email, docs]) => {
        // Ad soyad → emaildən al, yoxdursa email göstər
        const studentName = (profilesNameCache && profilesNameCache[email]) || null;
        const displayName = studentName || email;
        const initials = displayName.trim().split(/\s+/)
          .map(w => w[0]).slice(0, 2).join('').toUpperCase() || '?';

        const studentCard = document.createElement('div');
        studentCard.style.cssText = 'margin-bottom:16px;';

        const header = document.createElement('div');
        header.style.cssText = 'display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;';
        header.innerHTML = `
          <div style="display:flex; align-items:center; gap:10px;">
            <div style="width:34px; height:34px; border-radius:50%; background:var(--navy); color:var(--gold); display:flex; align-items:center; justify-content:center; font-family:'Fraunces',serif; font-weight:600; font-size:13px; flex-shrink:0;">
              ${initials}
            </div>
            <div>
              <p style="font-size:13px; font-weight:600; color:var(--navy); margin:0;">${escapeHtml(displayName)}</p>
              <p style="font-size:11px; color:var(--ink-soft); margin:0;">${studentName ? escapeHtml(email) + ' · ' : ''}${docs.length} sənəd</p>
            </div>
          </div>
          <span class="status-badge done">${docs.length} ✓</span>`;
        studentCard.appendChild(header);

        const docCard = document.createElement('div');
        docCard.className = 'admin-card';

        docs.forEach(doc => {
          const row = document.createElement('div');
          row.className = 'admin-card-row';
          const isImage = doc.file_url && /\.(jpg|jpeg|png|gif|webp|heic)$/i.test(doc.file_url.split('?')[0]);
          const viewUrl = doc._viewUrl;
          const uploadDate = doc.uploaded_at
            ? new Date(doc.uploaded_at).toLocaleDateString('az-AZ', { day: '2-digit', month: 'short', year: 'numeric' })
            : '—';
          const meta = docStatusMeta(doc.status);

          row.innerHTML = `
            <input type="checkbox" class="doc-bulk-check" data-id="${doc.id}" style="flex-shrink:0; width:16px; height:16px;">
            <div style="display:flex; align-items:center; gap:10px; flex:1; min-width:0;">
              ${isImage && viewUrl
              ? `<a href="${viewUrl}" target="_blank" rel="noopener noreferrer" style="flex-shrink:0; display:block; width:44px; height:44px; border-radius:8px; overflow:hidden; border:1px solid var(--line);">
                    <img src="${viewUrl}" style="width:44px; height:44px; object-fit:cover;" loading="lazy" alt="${escapeHtml(doc.doc_name)}">
                  </a>`
              : `<div style="flex-shrink:0; width:44px; height:44px; border-radius:8px; background:var(--teal-bg); display:flex; align-items:center; justify-content:center; font-size:20px; border:1px solid var(--line);">📄</div>`
            }
              <div class="admin-card-row-info">
                <p class="admin-row-name">${escapeHtml(doc.doc_name) || '—'}</p>
                <p class="admin-row-sub">Yükləndi: ${uploadDate} · <span class="status-badge ${meta.cls}" style="font-size:10px; padding:1px 6px;">${meta.label}</span></p>
                ${doc.status === 'rejected' && doc.rejection_note ? `<p style="font-size:11px; color:var(--coral); margin:3px 0 0;">Səbəb: ${escapeHtml(doc.rejection_note)}</p>` : ''}
              </div>
            </div>
            <div style="display:flex; gap:6px; align-items:center; flex-shrink:0; flex-wrap:wrap; justify-content:flex-end;">
              ${viewUrl
              ? `<a href="${viewUrl}" target="_blank" rel="noopener noreferrer" class="admin-action-btn" style="font-size:11px; text-decoration:none; display:inline-flex; align-items:center; gap:3px;">
                    ${isImage ? '🖼️' : '📄'} Aç ↗
                  </a>`
              : '<span style="font-size:11px; color:var(--ink-soft);">Link yoxdur</span>'
            }
              ${doc.status !== 'approved' ? `<button class="admin-action-btn approve-doc-btn" data-id="${doc.id}" style="font-size:11px;">✓ Təsdiqlə</button>` : ''}
              ${doc.status !== 'rejected' ? `<button class="admin-action-btn danger reject-doc-btn" data-id="${doc.id}" style="font-size:11px;">✗ Rədd et</button>` : ''}
            </div>`;
          docCard.appendChild(row);
        });

        studentCard.appendChild(docCard);
        listEl.appendChild(studentCard);
      });

      listEl.querySelectorAll('.doc-bulk-check').forEach(chk => {
        chk.addEventListener('change', () => {
          if (chk.checked) selectedDocIds.add(chk.dataset.id); else selectedDocIds.delete(chk.dataset.id);
          updateDocsBulkBar();
        });
      });
      listEl.querySelectorAll('.approve-doc-btn').forEach(btn => {
        btn.addEventListener('click', () => approveDocuments([btn.dataset.id]));
      });
      listEl.querySelectorAll('.reject-doc-btn').forEach(btn => {
        btn.addEventListener('click', () => rejectDocuments([btn.dataset.id]));
      });
    }

    // ── İşçilər (yalnız Admin) ────────────────────────────────

    async function loadStaff() {
      const listEl = document.getElementById('admin-staff-list');
      listEl.innerHTML = '<div class="skeleton-card"><div class="skeleton skeleton-line wide"></div><div class="skeleton skeleton-line narrow"></div></div>'.repeat(2);

      if (!sb) { listEl.innerHTML = '<div class="admin-empty"><span class="empty-icon">⚠️</span>Supabase bağlantısı yoxdur.</div>'; return; }

      // "Yeni işçi əlavə et" axtarış siyahısı — bütün istifadəçilər (tələbələr daxil),
      // ki, ad-soyadını bilib email-ini bilmədiyin birini də tapa biləsən.
      profilesNameCache = null;
      await loadProfilesCache();
      const dl = document.getElementById('staff-search-datalist');
      if (dl && profilesNameCache) {
        dl.innerHTML = Object.entries(profilesNameCache)
          .filter(([email, name]) => name)
          .map(([email, name]) => `<option value="${escapeHtml(name)} — ${escapeHtml(email)}">`)
          .join('');
      }

      const { data, error } = await sb.from('profiles')
        .select('name, email, role, created_at')
        .in('role', ['admin', 'staff'])
        .order('created_at', { ascending: false });

      if (error) {
        listEl.innerHTML = `<div class="admin-empty"><span class="empty-icon">❌</span>Məlumat yüklənmədi: ${escapeHtml(error.message)}</div>`;
        return;
      }
      if (!data || !data.length) {
        listEl.innerHTML = '<div class="admin-empty"><span class="empty-icon">👨‍💼</span>Hələ işçi əlavə edilməyib.</div>';
        return;
      }

      const card = document.createElement('div');
      card.className = 'admin-card';
      data.forEach(staff => {
        const isSelf = staff.email === currentEmail;
        const row = document.createElement('div');
        row.className = 'admin-card-row';
        row.innerHTML = `
          <div class="admin-card-row-info">
            <p class="admin-row-name">${escapeHtml(staff.name) || escapeHtml(staff.email)}</p>
            <p class="admin-row-sub">${escapeHtml(staff.email)}</p>
          </div>
          <div style="display:flex; gap:6px; align-items:center; flex-shrink:0;">
            <span class="status-badge ${staff.role === 'admin' ? 'admin-role' : 'staff'}">${staff.role === 'admin' ? 'Admin' : 'İşçi'}</span>
            ${!isSelf ? `
              <button class="admin-action-btn toggle-role-btn" data-email="${escapeHtml(staff.email)}" data-role="${staff.role}">${staff.role === 'admin' ? '↓ Staff et' : '↑ Admin et'}</button>
              <button class="admin-action-btn danger delete-staff-btn" data-email="${escapeHtml(staff.email)}" data-name="${escapeHtml(staff.name) || escapeHtml(staff.email)}">Sil</button>
            ` : '<span style="font-size:11px; color:var(--ink-soft);">(siz)</span>'}
          </div>`;
        card.appendChild(row);
      });

      listEl.innerHTML = '';
      listEl.appendChild(card);

      // Rol dəyiş
      listEl.querySelectorAll('.toggle-role-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const newRole = btn.dataset.role === 'admin' ? 'staff' : 'admin';
          btn.textContent = '...';
          await sb.from('profiles').update({ role: newRole }).eq('email', btn.dataset.email);
          logAudit('Rol dəyişdirildi', btn.dataset.email, newRole);
          toast('✓ Rol dəyişdirildi');
          loadStaff();
        });
      });

      // Sil düyməsi
      listEl.querySelectorAll('.delete-staff-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          staffToDelete = btn.dataset.email;
          document.getElementById('staff-delete-text').textContent =
            `"${btn.dataset.name}" istifadəçisini işçi siyahısından silmək istədiyinizə əminsinizmi? Bu əməliyyat rolu "student"a qaytarır.`;
          openModal('staff-delete-modal');
        });
      });
    }

    async function addStaffMember(email, role) {
      if (!sb || !email) return;
      // Mövcud profil yoxla, yoxdursa yeni sətir yarat
      const { data: existing } = await sb.from('profiles').select('email').eq('email', email).limit(1);
      if (existing && existing.length > 0) {
        const { error } = await sb.from('profiles').update({ role }).eq('email', email);
        if (error) { toast('Xəta: ' + error.message, true); return; }
      } else {
        const { error } = await sb.from('profiles').insert({ email, role, name: email.split('@')[0] });
        if (error) { toast('Xəta: ' + error.message, true); return; }
      }
      logAudit('İşçi əlavə edildi', email, role);
      toast('✓ İşçi əlavə edildi!');
      loadStaff();
    }

    // ── Admin Naviqasiyası (alt naviqasiya + "Daha" menyusu) ────
    let currentAdminTab = 'dashboard';

    function goToAdminTab(tabId) {
      currentAdminTab = tabId;
      document.querySelectorAll('.admin-panel').forEach(p => p.classList.remove('active'));
      document.getElementById('admin-panel-' + tabId).classList.add('active');

      // Alt naviqasiyadakı 4 əsas düymənin aktiv vəziyyəti (staff/audit "Daha"-dan
      // açıldığı üçün alt naviqasiyada uyğun gələn düymələri yoxdur)
      document.querySelectorAll('.admin-navbtn[data-admin-tab]').forEach(b => {
        b.classList.toggle('active', b.dataset.adminTab === tabId);
      });

      // Lazy load per tab
      if (tabId === 'students') loadStudents();
      else if (tabId === 'appointments') loadAppointments();
      else if (tabId === 'documents') loadAdminDocuments();
      else if (tabId === 'staff') loadStaff();
      else if (tabId === 'audit') loadAuditLog();
      else if (tabId === 'doctemplates') loadDocTemplatesAdmin();
      else if (tabId === 'universities') loadUniversitiesAdmin();
      else if (tabId === 'achievements') loadAchievementsAdmin();
      else if (tabId === 'team') loadTeamAdmin();
      else if (tabId === 'partner-unis') loadPartnerUnisAdmin();
      else if (tabId === 'services') loadServicesAdmin();
      else if (tabId === 'news') loadNewsAdmin();
      else if (tabId === 'examresults') loadExamResultsAdmin();
      else if (tabId === 'trialexams') { loadTrialExamsAdmin(); loadTrialExamRegsAdmin(); }
      else if (tabId === 'analytics') loadAnalytics();
    }

    document.querySelectorAll('.admin-navbtn[data-admin-tab]').forEach(btn => {
      btn.addEventListener('click', () => goToAdminTab(btn.dataset.adminTab));
    });

    // "Daha" bölmə vərəqi
    document.getElementById('admin-more-btn').addEventListener('click', () => openModal('admin-more-modal'));
    document.getElementById('admin-more-close').addEventListener('click', () => closeModal('admin-more-modal'));
    document.getElementById('admin-more-modal').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeModal('admin-more-modal');
    });
    document.querySelectorAll('#admin-more-modal .admin-more-row[data-admin-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        closeModal('admin-more-modal');
        goToAdminTab(btn.dataset.adminTab);
      });
    });
    document.getElementById('admin-more-logout').addEventListener('click', () => {
      document.getElementById('admin-logout-btn').click();
    });

    /* ═══════════════════════════════════════════════════════════
       ADMIN — SƏNƏD ŞABLONLARI
    ═══════════════════════════════════════════════════════════ */
    async function loadDocTemplatesAdmin() {
      const listEl = document.getElementById('admin-doctemplates-list');
      listEl.innerHTML = '<div class="skeleton-card"><div class="skeleton skeleton-line wide"></div><div class="skeleton skeleton-line narrow"></div></div>'.repeat(3);

      // Ölkə seçimini doldur (bir dəfə)
      const countrySel = document.getElementById('new-doc-country');
      if (countrySel && !countrySel.options.length) {
        countrySel.innerHTML = '<option value="">Bütün ölkələr</option>' +
          Object.keys(DATA).map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
      }

      if (!sb) { listEl.innerHTML = '<div class="admin-empty"><span class="empty-icon">⚠️</span>Supabase bağlantısı yoxdur.</div>'; return; }

      const { data, error } = await sb.from('document_templates')
        .select('*')
        .order('sort_order', { ascending: true })
        .order('id', { ascending: true });

      if (error) {
        listEl.innerHTML = `
          <div class="admin-empty" style="text-align:left; padding:16px;">
            <span class="empty-icon">❌</span>
            <b>Cədvəl tapılmadı</b><br>
            <span style="font-size:12px; color:var(--ink-soft);">${escapeHtml(error.message)}</span><br><br>
            <span style="font-size:11px; color:var(--ink-soft);">
              <b>supabase-security-setup.sql</b> faylını Supabase → SQL Editor-da icra edin.</span>
          </div>`;
        return;
      }

      if (!data || !data.length) {
        listEl.innerHTML = `
          <div class="admin-empty" style="text-align:left; padding:16px;">
            <span class="empty-icon">📋</span>
            <b>Baza siyahısı boşdur</b><br>
            <span style="font-size:12px; color:var(--ink-soft); line-height:1.6;">
              Hazırda tələbələrə tətbiqin daxili 11 sənədlik siyahısı göstərilir.
              Aşağıdakı düymə ilə onu bazaya köçürüb sonra buradan idarə edə bilərsiniz.</span>
            <div class="admin-confirm-row">
              <button class="admin-btn-primary" id="seed-doctemplates-btn">Daxili siyahını bazaya köçür</button>
            </div>
          </div>`;
        document.getElementById('seed-doctemplates-btn')?.addEventListener('click', seedDocTemplates);
        return;
      }

      const card = document.createElement('div');
      card.className = 'admin-card';
      data.forEach(t => {
        const row = document.createElement('div');
        row.className = 'admin-card-row';
        row.innerHTML = `
          <div class="admin-card-row-info">
            <p class="admin-row-name">${escapeHtml(t.doc_name)}${t.active ? '' : ' (deaktiv)'}</p>
            <p class="admin-row-sub">${t.country ? escapeHtml(t.country) : 'Bütün ölkələr'} · ${t.due_date ? escapeHtml(t.due_date) : 'tarixsiz'} · sıra ${t.sort_order}</p>
          </div>
          <div style="display:flex; gap:6px; align-items:center; flex-shrink:0;">
            <button class="admin-action-btn toggle-doc-tpl" data-id="${t.id}" data-active="${t.active}">${t.active ? 'Gizlət' : 'Göstər'}</button>
            <button class="admin-action-btn danger del-doc-tpl" data-id="${t.id}" data-name="${escapeHtml(t.doc_name)}">Sil</button>
          </div>`;
        card.appendChild(row);
      });
      listEl.innerHTML = '';
      listEl.appendChild(card);

      listEl.querySelectorAll('.toggle-doc-tpl').forEach(btn => {
        btn.addEventListener('click', async () => {
          const newActive = btn.dataset.active !== 'true';
          await sb.from('document_templates').update({ active: newActive }).eq('id', btn.dataset.id);
          logAudit('Sənəd şablonu dəyişdirildi', btn.dataset.id, newActive ? 'aktiv' : 'deaktiv');
          docTemplatesCache = null;
          toast('✓ Yeniləndi');
          loadDocTemplatesAdmin();
        });
      });
      listEl.querySelectorAll('.del-doc-tpl').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm(`"${btn.dataset.name}" sənədini siyahıdan silmək istədiyinizə əminsiniz?`)) return;
          await sb.from('document_templates').delete().eq('id', btn.dataset.id);
          logAudit('Sənəd şablonu silindi', btn.dataset.name);
          docTemplatesCache = null;
          toast('✓ Silindi');
          loadDocTemplatesAdmin();
        });
      });
    }

    async function seedDocTemplates() {
      if (!sb) return;
      const rows = DEFAULT_DOC_TEMPLATES.map((t, i) => ({
        doc_name: t.doc_name, country: null, due_date: null, sort_order: i, active: true
      }));
      const { error } = await sb.from('document_templates').insert(rows);
      if (error) { toast('Xəta: ' + error.message, true); return; }
      logAudit('Sənəd şablonları bazaya köçürüldü', '', rows.length + ' sənəd');
      docTemplatesCache = null;
      toast('✓ Siyahı bazaya köçürüldü');
      loadDocTemplatesAdmin();
    }

    document.getElementById('add-doc-template-btn')?.addEventListener('click', async () => {
      const name = document.getElementById('new-doc-name').value.trim();
      const country = document.getElementById('new-doc-country').value || null;
      const due = document.getElementById('new-doc-due').value || null;
      const order = parseInt(document.getElementById('new-doc-order').value, 10) || 0;
      if (!name) { toast('Sənədin adını yazın', true); return; }
      if (!sb) return;
      const { error } = await sb.from('document_templates')
        .insert({ doc_name: name, country, due_date: due, sort_order: order, active: true });
      if (error) { toast('Xəta: ' + error.message, true); return; }
      logAudit('Sənəd şablonu əlavə edildi', name, country || 'bütün ölkələr');
      document.getElementById('new-doc-name').value = '';
      document.getElementById('new-doc-due').value = '';
      docTemplatesCache = null;
      toast('✓ Sənəd əlavə edildi');
      loadDocTemplatesAdmin();
    });

    /* ═══════════════════════════════════════════════════════════
       ADMIN — UNİVERSİTET KATALOQU
    ═══════════════════════════════════════════════════════════ */
    let universitiesAdminCache = [];

    async function loadUniversitiesAdmin() {
      const listEl = document.getElementById('admin-universities-list');
      listEl.innerHTML = '<div class="skeleton-card"><div class="skeleton skeleton-line wide"></div><div class="skeleton skeleton-line narrow"></div></div>'.repeat(3);

      const dl = document.getElementById('uni-country-list');
      if (dl && !dl.options.length) {
        dl.innerHTML = Object.keys(DATA).map(c => `<option value="${escapeHtml(c)}">`).join('');
      }

      if (!sb) { listEl.innerHTML = '<div class="admin-empty"><span class="empty-icon">⚠️</span>Supabase bağlantısı yoxdur.</div>'; return; }

      const { data, error } = await sb.from('universities')
        .select('*')
        .order('country', { ascending: true })
        .order('name', { ascending: true });

      if (error) {
        listEl.innerHTML = `
          <div class="admin-empty" style="text-align:left; padding:16px;">
            <span class="empty-icon">❌</span>
            <b>Cədvəl tapılmadı</b><br>
            <span style="font-size:12px; color:var(--ink-soft);">${escapeHtml(error.message)}</span><br><br>
            <span style="font-size:11px; color:var(--ink-soft);"><b>supabase-security-setup.sql</b> faylını icra edin.</span>
          </div>`;
        return;
      }

      universitiesAdminCache = data || [];
      renderUniversitiesAdmin();
    }

    function renderUniversitiesAdmin() {
      const listEl = document.getElementById('admin-universities-list');
      const q = (document.getElementById('uni-admin-search')?.value || '').trim().toLowerCase();
      const rows = universitiesAdminCache.filter(u =>
        !q || u.name.toLowerCase().includes(q) || u.country.toLowerCase().includes(q));

      if (!universitiesAdminCache.length) {
        listEl.innerHTML = '<div class="admin-empty"><span class="empty-icon">🎓</span>Baza boşdur — hazırda daxili siyahı istifadə olunur.</div>';
        return;
      }
      if (!rows.length) {
        listEl.innerHTML = '<div class="admin-empty"><span class="empty-icon">🔍</span>Axtarışa uyğun universitet tapılmadı.</div>';
        return;
      }

      const LIMIT = 100;
      const card = document.createElement('div');
      card.className = 'admin-card';
      rows.slice(0, LIMIT).forEach(u => {
        const row = document.createElement('div');
        row.className = 'admin-card-row';
        row.innerHTML = `
          <div class="admin-card-row-info">
            <p class="admin-row-name">${escapeHtml(u.name)}</p>
            <p class="admin-row-sub">${escapeHtml(u.country)}</p>
          </div>
          <button class="admin-action-btn danger del-uni" data-id="${u.id}" data-name="${escapeHtml(u.name)}">Sil</button>`;
        card.appendChild(row);
      });
      listEl.innerHTML = '';
      listEl.appendChild(card);

      if (rows.length > LIMIT) {
        const more = document.createElement('p');
        more.className = 'admin-row-sub';
        more.style.cssText = 'text-align:center; padding:10px 0;';
        more.textContent = `+ ${rows.length - LIMIT} universitet də var — axtarışla daraldın.`;
        listEl.appendChild(more);
      }

      listEl.querySelectorAll('.del-uni').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm(`"${btn.dataset.name}" universitetini silmək istədiyinizə əminsiniz?`)) return;
          await sb.from('universities').delete().eq('id', btn.dataset.id);
          logAudit('Universitet silindi', btn.dataset.name);
          toast('✓ Silindi');
          loadUniversitiesAdmin();
        });
      });
    }

    document.getElementById('uni-admin-search')?.addEventListener('input', renderUniversitiesAdmin);

    document.getElementById('add-university-btn')?.addEventListener('click', async () => {
      const country = document.getElementById('new-uni-country').value.trim();
      const name = document.getElementById('new-uni-name').value.trim();
      if (!country || !name) { toast('Ölkə və universitet adını yazın', true); return; }
      if (!sb) return;
      const { error } = await sb.from('universities').insert({ country, name, active: true });
      if (error) { toast('Xəta: ' + error.message, true); return; }
      logAudit('Universitet əlavə edildi', name, country);
      document.getElementById('new-uni-name').value = '';
      toast('✓ Universitet əlavə edildi');
      loadUniversitiesAdmin();
    });

    document.getElementById('seed-universities-btn')?.addEventListener('click', async () => {
      if (!sb) return;
      if (!confirm('Daxili siyahı (22 ölkə, 250+ universitet) bazaya köçürülsün?')) return;
      const btn = document.getElementById('seed-universities-btn');
      btn.disabled = true; btn.textContent = 'Köçürülür...';

      const rows = [];
      Object.keys(BUILTIN_DATA).forEach(country => {
        Object.keys(BUILTIN_DATA[country]).forEach(name => rows.push({ country, name, active: true }));
      });

      // Böyük siyahını hissə-hissə göndəririk ki, sorğu limitini aşmasın
      let inserted = 0, failed = 0;
      for (let i = 0; i < rows.length; i += 100) {
        const chunk = rows.slice(i, i + 100);
        const { error } = await sb.from('universities').upsert(chunk, { onConflict: 'country,name', ignoreDuplicates: true });
        if (error) failed += chunk.length; else inserted += chunk.length;
      }

      btn.disabled = false; btn.textContent = 'Daxili siyahını bazaya köçür';
      logAudit('Universitet siyahısı bazaya köçürüldü', '', inserted + ' universitet');
      toast(failed ? `${inserted} əlavə edildi, ${failed} alınmadı` : `✓ ${inserted} universitet köçürüldü`, !!failed);
      loadUniversitiesAdmin();
    });

    /* ═══════════════════════════════════════════════════════════
       ADMIN — NAİLİYYƏTLƏR ("Haqqımızda" ekranındakı şəkilli bölmə)
    ═══════════════════════════════════════════════════════════ */
    async function loadAchievementsAdmin() {
      const listEl = document.getElementById('admin-achievements-list');
      listEl.innerHTML = '<div class="skeleton-card"><div class="skeleton skeleton-line wide"></div><div class="skeleton skeleton-line narrow"></div></div>'.repeat(3);

      if (!sb) { listEl.innerHTML = '<div class="admin-empty"><span class="empty-icon">⚠️</span>Supabase bağlantısı yoxdur.</div>'; return; }

      const { data, error } = await sb.from('achievements')
        .select('*')
        .order('sort_order', { ascending: true })
        .order('id', { ascending: true });

      if (error) {
        listEl.innerHTML = `
          <div class="admin-empty" style="text-align:left; padding:16px;">
            <span class="empty-icon">❌</span>
            <b>Cədvəl tapılmadı</b><br>
            <span style="font-size:12px; color:var(--ink-soft);">${escapeHtml(error.message)}</span><br><br>
            <span style="font-size:11px; color:var(--ink-soft);">
              <b>supabase-security-setup.sql</b> faylını Supabase → SQL Editor-da icra edin.</span>
          </div>`;
        return;
      }

      if (!data || !data.length) {
        listEl.innerHTML = '<div class="admin-empty"><span class="empty-icon">🏆</span>Hələ heç bir nailiyyət əlavə olunmayıb.</div>';
        return;
      }

      const card = document.createElement('div');
      card.className = 'admin-card';
      data.forEach(a => {
        const row = document.createElement('div');
        row.className = 'admin-card-row';
        row.innerHTML = `
          <img src="${escapeHtml(a.image_url)}" alt="" style="width:44px; height:44px; border-radius:8px; object-fit:cover; flex-shrink:0;">
          <div class="admin-card-row-info">
            <p class="admin-row-name">${escapeHtml(a.caption)}${a.active ? '' : ' (gizli)'}</p>
            <p class="admin-row-sub">sıra ${a.sort_order}</p>
          </div>
          <div style="display:flex; gap:6px; align-items:center; flex-shrink:0;">
            <button class="admin-action-btn toggle-achieve" data-id="${a.id}" data-active="${a.active}">${a.active ? 'Gizlət' : 'Göstər'}</button>
            <button class="admin-action-btn danger del-achieve" data-id="${a.id}" data-path="${escapeHtml(a.image_url)}">Sil</button>
          </div>`;
        card.appendChild(row);
      });
      listEl.innerHTML = '';
      listEl.appendChild(card);

      listEl.querySelectorAll('.toggle-achieve').forEach(btn => {
        btn.addEventListener('click', async () => {
          const newActive = btn.dataset.active !== 'true';
          await sb.from('achievements').update({ active: newActive }).eq('id', btn.dataset.id);
          logAudit('Nailiyyət dəyişdirildi', btn.dataset.id, newActive ? 'aktiv' : 'gizli');
          toast('✓ Yeniləndi');
          loadAchievementsAdmin();
          loadAchievements();
        });
      });
      listEl.querySelectorAll('.del-achieve').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Bu nailiyyəti silmək istədiyinizə əminsiniz?')) return;
          await sb.from('achievements').delete().eq('id', btn.dataset.id);
          logAudit('Nailiyyət silindi', btn.dataset.id);
          toast('✓ Silindi');
          loadAchievementsAdmin();
          loadAchievements();
        });
      });
    }

    document.getElementById('add-achievement-btn')?.addEventListener('click', async () => {
      const fileInp = document.getElementById('new-achieve-file');
      const caption = document.getElementById('new-achieve-caption').value.trim();
      const order = parseInt(document.getElementById('new-achieve-order').value, 10) || 0;
      const file = fileInp.files && fileInp.files[0];

      if (!file) { toast('Şəkil seçin', true); return; }
      if (!caption) { toast('Qısa izah yazın', true); return; }
      if (!sb) return;

      const MAX_UPLOAD_MB = 8;
      if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
        toast(`Şəkil çox böyükdür (maks. ${MAX_UPLOAD_MB}MB).`, true);
        return;
      }

      const btn = document.getElementById('add-achievement-btn');
      btn.disabled = true; btn.textContent = 'Yüklənir...';

      const fileExt = file.name.split('.').pop();
      const fileName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${fileExt}`;

      const { error: upErr } = await sb.storage.from('Achievements').upload(fileName, file);
      if (upErr) {
        toast('Xəta: ' + upErr.message, true);
        btn.disabled = false; btn.textContent = 'Əlavə et';
        return;
      }

      const { data: pub } = sb.storage.from('Achievements').getPublicUrl(fileName);
      const { error } = await sb.from('achievements')
        .insert({ image_url: pub.publicUrl, caption, sort_order: order, active: true });

      btn.disabled = false; btn.textContent = 'Əlavə et';

      if (error) { toast('Xəta: ' + error.message, true); return; }
      logAudit('Nailiyyət əlavə edildi', caption);
      fileInp.value = '';
      document.getElementById('new-achieve-caption').value = '';
      toast('✓ Nailiyyət əlavə edildi');
      loadAchievementsAdmin();
      loadAchievements();
    });

    /* ═══════════════════════════════════════════════════════════
       ADMIN — ƏMƏKDAŞLARIMIZ (komanda)
    ═══════════════════════════════════════════════════════════ */
    async function loadTeamAdmin() {
      const listEl = document.getElementById('admin-team-list');
      listEl.innerHTML = '<div class="skeleton-card"><div class="skeleton skeleton-line wide"></div><div class="skeleton skeleton-line narrow"></div></div>'.repeat(3);

      if (!sb) { listEl.innerHTML = '<div class="admin-empty"><span class="empty-icon">⚠️</span>Supabase bağlantısı yoxdur.</div>'; return; }

      const { data, error } = await sb.from('team_members')
        .select('*')
        .order('sort_order', { ascending: true })
        .order('id', { ascending: true });

      if (error) {
        listEl.innerHTML = `
          <div class="admin-empty" style="text-align:left; padding:16px;">
            <span class="empty-icon">❌</span>
            <b>Cədvəl tapılmadı</b><br>
            <span style="font-size:12px; color:var(--ink-soft);">${escapeHtml(error.message)}</span><br><br>
            <span style="font-size:11px; color:var(--ink-soft);">
              <b>supabase-security-setup.sql</b> faylını Supabase → SQL Editor-da icra edin.</span>
          </div>`;
        return;
      }

      if (!data || !data.length) {
        listEl.innerHTML = '<div class="admin-empty"><span class="empty-icon">🧑‍🏫</span>Hələ əməkdaş əlavə olunmayıb.</div>';
        return;
      }

      const card = document.createElement('div');
      card.className = 'admin-card';
      data.forEach(m => {
        const row = document.createElement('div');
        row.className = 'admin-card-row';
        row.innerHTML = `
          ${m.photo_url ? `<img src="${escapeHtml(m.photo_url)}" alt="" style="width:44px; height:44px; border-radius:50%; object-fit:cover; flex-shrink:0;">` : `<div style="width:44px; height:44px; border-radius:50%; background:var(--teal-bg); display:flex; align-items:center; justify-content:center; font-size:18px; flex-shrink:0;">🧑‍🏫</div>`}
          <div class="admin-card-row-info">
            <p class="admin-row-name">${escapeHtml(m.name)}${m.active ? '' : ' (gizli)'}</p>
            <p class="admin-row-sub">${m.title ? escapeHtml(m.title) + ' · ' : ''}sıra ${m.sort_order}</p>
          </div>
          <div style="display:flex; gap:6px; align-items:center; flex-shrink:0;">
            <button class="admin-action-btn toggle-team" data-id="${m.id}" data-active="${m.active}">${m.active ? 'Gizlət' : 'Göstər'}</button>
            <button class="admin-action-btn danger del-team" data-id="${m.id}">Sil</button>
          </div>`;
        card.appendChild(row);
      });
      listEl.innerHTML = '';
      listEl.appendChild(card);

      listEl.querySelectorAll('.toggle-team').forEach(btn => {
        btn.addEventListener('click', async () => {
          const newActive = btn.dataset.active !== 'true';
          await sb.from('team_members').update({ active: newActive }).eq('id', btn.dataset.id);
          logAudit('Əməkdaş dəyişdirildi', btn.dataset.id, newActive ? 'aktiv' : 'gizli');
          toast('✓ Yeniləndi');
          loadTeamAdmin();
          loadTeamMembers();
        });
      });
      listEl.querySelectorAll('.del-team').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Bu əməkdaşı silmək istədiyinizə əminsiniz?')) return;
          await sb.from('team_members').delete().eq('id', btn.dataset.id);
          logAudit('Əməkdaş silindi', btn.dataset.id);
          toast('✓ Silindi');
          loadTeamAdmin();
          loadTeamMembers();
        });
      });
    }

    document.getElementById('add-team-btn')?.addEventListener('click', async () => {
      const fileInp = document.getElementById('new-team-file');
      const name = document.getElementById('new-team-name').value.trim();
      const title = document.getElementById('new-team-title').value.trim();
      const order = parseInt(document.getElementById('new-team-order').value, 10) || 0;
      const file = fileInp.files && fileInp.files[0];

      if (!name) { toast('Ad Soyad yazın', true); return; }
      if (!sb) return;

      const btn = document.getElementById('add-team-btn');
      btn.disabled = true; btn.textContent = 'Əlavə edilir...';

      let photoUrl = null;
      if (file) {
        const MAX_UPLOAD_MB = 8;
        if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
          toast(`Şəkil çox böyükdür (maks. ${MAX_UPLOAD_MB}MB).`, true);
          btn.disabled = false; btn.textContent = 'Əlavə et';
          return;
        }
        const fileExt = file.name.split('.').pop();
        const fileName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${fileExt}`;
        const { error: upErr } = await sb.storage.from('TeamPhotos').upload(fileName, file);
        if (upErr) {
          toast('Xəta: ' + upErr.message, true);
          btn.disabled = false; btn.textContent = 'Əlavə et';
          return;
        }
        const { data: pub } = sb.storage.from('TeamPhotos').getPublicUrl(fileName);
        photoUrl = pub.publicUrl;
      }

      const { error } = await sb.from('team_members')
        .insert({ name, title: title || null, photo_url: photoUrl, sort_order: order, active: true });

      btn.disabled = false; btn.textContent = 'Əlavə et';

      if (error) { toast('Xəta: ' + error.message, true); return; }
      logAudit('Əməkdaş əlavə edildi', name);
      fileInp.value = '';
      document.getElementById('new-team-name').value = '';
      document.getElementById('new-team-title').value = '';
      toast('✓ Əməkdaş əlavə edildi');
      loadTeamAdmin();
      loadTeamMembers();
    });

    /* ═══════════════════════════════════════════════════════════
       ADMIN — ƏMƏKDAŞ UNİVERSİTETLƏR
    ═══════════════════════════════════════════════════════════ */
    async function loadPartnerUnisAdmin() {
      const listEl = document.getElementById('admin-partner-unis-list');
      listEl.innerHTML = '<div class="skeleton-card"><div class="skeleton skeleton-line wide"></div><div class="skeleton skeleton-line narrow"></div></div>'.repeat(3);

      if (!sb) { listEl.innerHTML = '<div class="admin-empty"><span class="empty-icon">⚠️</span>Supabase bağlantısı yoxdur.</div>'; return; }

      const { data, error } = await sb.from('partner_universities')
        .select('*')
        .order('sort_order', { ascending: true })
        .order('id', { ascending: true });

      if (error) {
        listEl.innerHTML = `
          <div class="admin-empty" style="text-align:left; padding:16px;">
            <span class="empty-icon">❌</span>
            <b>Cədvəl tapılmadı</b><br>
            <span style="font-size:12px; color:var(--ink-soft);">${escapeHtml(error.message)}</span><br><br>
            <span style="font-size:11px; color:var(--ink-soft);">
              <b>supabase-security-setup.sql</b> faylını Supabase → SQL Editor-da icra edin.</span>
          </div>`;
        return;
      }

      if (!data || !data.length) {
        listEl.innerHTML = '<div class="admin-empty"><span class="empty-icon">🤝</span>Hələ əməkdaş universitet əlavə olunmayıb.</div>';
        return;
      }

      const card = document.createElement('div');
      card.className = 'admin-card';
      data.forEach(u => {
        const row = document.createElement('div');
        row.className = 'admin-card-row';
        row.innerHTML = `
          <div class="admin-card-row-info">
            <p class="admin-row-name">${escapeHtml(u.name)}${u.active ? '' : ' (gizli)'}</p>
            <p class="admin-row-sub">${u.country ? escapeHtml(u.country) + ' · ' : ''}sıra ${u.sort_order}</p>
          </div>
          <div style="display:flex; gap:6px; align-items:center; flex-shrink:0;">
            <button class="admin-action-btn toggle-partner-uni" data-id="${u.id}" data-active="${u.active}">${u.active ? 'Gizlət' : 'Göstər'}</button>
            <button class="admin-action-btn danger del-partner-uni" data-id="${u.id}">Sil</button>
          </div>`;
        card.appendChild(row);
      });
      listEl.innerHTML = '';
      listEl.appendChild(card);

      listEl.querySelectorAll('.toggle-partner-uni').forEach(btn => {
        btn.addEventListener('click', async () => {
          const newActive = btn.dataset.active !== 'true';
          await sb.from('partner_universities').update({ active: newActive }).eq('id', btn.dataset.id);
          logAudit('Əməkdaş universitet dəyişdirildi', btn.dataset.id, newActive ? 'aktiv' : 'gizli');
          toast('✓ Yeniləndi');
          loadPartnerUnisAdmin();
          loadPartnerUniversities();
        });
      });
      listEl.querySelectorAll('.del-partner-uni').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Bu universiteti siyahıdan silmək istədiyinizə əminsiniz?')) return;
          await sb.from('partner_universities').delete().eq('id', btn.dataset.id);
          logAudit('Əməkdaş universitet silindi', btn.dataset.id);
          toast('✓ Silindi');
          loadPartnerUnisAdmin();
          loadPartnerUniversities();
        });
      });
    }

    document.getElementById('add-partner-uni-btn')?.addEventListener('click', async () => {
      const name = document.getElementById('new-partner-uni-name').value.trim();
      const country = document.getElementById('new-partner-uni-country').value.trim();
      const order = parseInt(document.getElementById('new-partner-uni-order').value, 10) || 0;
      if (!name) { toast('Universitetin adını yazın', true); return; }
      if (!sb) return;

      const { error } = await sb.from('partner_universities')
        .insert({ name, country: country || null, sort_order: order, active: true });

      if (error) { toast('Xəta: ' + error.message, true); return; }
      logAudit('Əməkdaş universitet əlavə edildi', name, country);
      document.getElementById('new-partner-uni-name').value = '';
      document.getElementById('new-partner-uni-country').value = '';
      toast('✓ Universitet əlavə edildi');
      loadPartnerUnisAdmin();
      loadPartnerUniversities();
    });

    /* ═══════════════════════════════════════════════════════════
       ADMIN — XİDMƏTLƏRİMİZ (qiymətlə)
    ═══════════════════════════════════════════════════════════ */
    async function loadServicesAdmin() {
      const listEl = document.getElementById('admin-services-list');
      listEl.innerHTML = '<div class="skeleton-card"><div class="skeleton skeleton-line wide"></div><div class="skeleton skeleton-line narrow"></div></div>'.repeat(3);

      if (!sb) { listEl.innerHTML = '<div class="admin-empty"><span class="empty-icon">⚠️</span>Supabase bağlantısı yoxdur.</div>'; return; }

      const { data, error } = await sb.from('services')
        .select('*')
        .order('sort_order', { ascending: true })
        .order('id', { ascending: true });

      if (error) {
        listEl.innerHTML = `
          <div class="admin-empty" style="text-align:left; padding:16px;">
            <span class="empty-icon">❌</span>
            <b>Cədvəl tapılmadı</b><br>
            <span style="font-size:12px; color:var(--ink-soft);">${escapeHtml(error.message)}</span><br><br>
            <span style="font-size:11px; color:var(--ink-soft);">
              <b>supabase-security-setup.sql</b> faylını Supabase → SQL Editor-da icra edin.</span>
          </div>`;
        return;
      }

      if (!data || !data.length) {
        listEl.innerHTML = '<div class="admin-empty"><span class="empty-icon">📚</span>Hələ xidmət əlavə olunmayıb.</div>';
        return;
      }

      const card = document.createElement('div');
      card.className = 'admin-card';
      data.forEach(s => {
        const row = document.createElement('div');
        row.className = 'admin-card-row';
        row.innerHTML = `
          <div class="admin-card-row-info">
            <p class="admin-row-name">${escapeHtml(s.name)}${s.active ? '' : ' (gizli)'}</p>
            <p class="admin-row-sub">${s.price_text ? escapeHtml(s.price_text) + ' · ' : ''}sıra ${s.sort_order}</p>
          </div>
          <div style="display:flex; gap:6px; align-items:center; flex-shrink:0;">
            <button class="admin-action-btn toggle-service" data-id="${s.id}" data-active="${s.active}">${s.active ? 'Gizlət' : 'Göstər'}</button>
            <button class="admin-action-btn danger del-service" data-id="${s.id}">Sil</button>
          </div>`;
        card.appendChild(row);
      });
      listEl.innerHTML = '';
      listEl.appendChild(card);

      listEl.querySelectorAll('.toggle-service').forEach(btn => {
        btn.addEventListener('click', async () => {
          const newActive = btn.dataset.active !== 'true';
          await sb.from('services').update({ active: newActive }).eq('id', btn.dataset.id);
          logAudit('Xidmət dəyişdirildi', btn.dataset.id, newActive ? 'aktiv' : 'gizli');
          toast('✓ Yeniləndi');
          loadServicesAdmin();
          loadServices();
        });
      });
      listEl.querySelectorAll('.del-service').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Bu xidməti silmək istədiyinizə əminsiniz?')) return;
          await sb.from('services').delete().eq('id', btn.dataset.id);
          logAudit('Xidmət silindi', btn.dataset.id);
          toast('✓ Silindi');
          loadServicesAdmin();
          loadServices();
        });
      });
    }

    document.getElementById('add-service-btn')?.addEventListener('click', async () => {
      const name = document.getElementById('new-service-name').value.trim();
      const price = document.getElementById('new-service-price').value.trim();
      const order = parseInt(document.getElementById('new-service-order').value, 10) || 0;
      if (!name) { toast('Xidmətin adını yazın', true); return; }
      if (!sb) return;

      const { error } = await sb.from('services')
        .insert({ name, price_text: price || null, sort_order: order, active: true });

      if (error) { toast('Xəta: ' + error.message, true); return; }
      logAudit('Xidmət əlavə edildi', name, price);
      document.getElementById('new-service-name').value = '';
      document.getElementById('new-service-price').value = '';
      toast('✓ Xidmət əlavə edildi');
      loadServicesAdmin();
      loadServices();
    });

    /* ═══════════════════════════════════════════════════════════
       ADMIN — ELANLAR/XƏBƏRLƏR
       DİQQƏT: bu, "Elan göndər" (bax: admin-more-announce, announcements
       cədvəli) ilə eyni şey deyil — o, bell bildirişidir; bu isə hər kəsin
       Haqqımızda ekranında gördüyü xəbər lentidir.
    ═══════════════════════════════════════════════════════════ */
    async function loadNewsAdmin() {
      const listEl = document.getElementById('admin-news-list');
      listEl.innerHTML = '<div class="skeleton-card"><div class="skeleton skeleton-line wide"></div><div class="skeleton skeleton-line narrow"></div></div>'.repeat(3);

      if (!sb) { listEl.innerHTML = '<div class="admin-empty"><span class="empty-icon">⚠️</span>Supabase bağlantısı yoxdur.</div>'; return; }

      const { data, error } = await sb.from('news_posts')
        .select('*')
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: false });

      if (error) {
        listEl.innerHTML = `
          <div class="admin-empty" style="text-align:left; padding:16px;">
            <span class="empty-icon">❌</span>
            <b>Cədvəl tapılmadı</b><br>
            <span style="font-size:12px; color:var(--ink-soft);">${escapeHtml(error.message)}</span><br><br>
            <span style="font-size:11px; color:var(--ink-soft);">
              <b>supabase-security-setup.sql</b> faylını Supabase → SQL Editor-da icra edin.</span>
          </div>`;
        return;
      }

      if (!data || !data.length) {
        listEl.innerHTML = '<div class="admin-empty"><span class="empty-icon">📰</span>Hələ xəbər əlavə olunmayıb.</div>';
        return;
      }

      const card = document.createElement('div');
      card.className = 'admin-card';
      data.forEach(n => {
        const row = document.createElement('div');
        row.className = 'admin-card-row';
        row.innerHTML = `
          <div class="admin-card-row-info">
            <p class="admin-row-name">${escapeHtml(n.title)}${n.active ? '' : ' (gizli)'}</p>
            <p class="admin-row-sub">${n.created_at ? new Date(n.created_at).toLocaleDateString('az-AZ') + ' · ' : ''}sıra ${n.sort_order}</p>
          </div>
          <div style="display:flex; gap:6px; align-items:center; flex-shrink:0;">
            <button class="admin-action-btn toggle-news" data-id="${n.id}" data-active="${n.active}">${n.active ? 'Gizlət' : 'Göstər'}</button>
            <button class="admin-action-btn danger del-news" data-id="${n.id}">Sil</button>
          </div>`;
        card.appendChild(row);
      });
      listEl.innerHTML = '';
      listEl.appendChild(card);

      listEl.querySelectorAll('.toggle-news').forEach(btn => {
        btn.addEventListener('click', async () => {
          const newActive = btn.dataset.active !== 'true';
          await sb.from('news_posts').update({ active: newActive }).eq('id', btn.dataset.id);
          logAudit('Xəbər dəyişdirildi', btn.dataset.id, newActive ? 'aktiv' : 'gizli');
          toast('✓ Yeniləndi');
          loadNewsAdmin();
          loadNews();
        });
      });
      listEl.querySelectorAll('.del-news').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Bu xəbəri silmək istədiyinizə əminsiniz?')) return;
          await sb.from('news_posts').delete().eq('id', btn.dataset.id);
          logAudit('Xəbər silindi', btn.dataset.id);
          toast('✓ Silindi');
          loadNewsAdmin();
          loadNews();
        });
      });
    }

    document.getElementById('add-news-btn')?.addEventListener('click', async () => {
      const title = document.getElementById('new-news-title').value.trim();
      const body = document.getElementById('new-news-body').value.trim();
      const order = parseInt(document.getElementById('new-news-order').value, 10) || 0;
      if (!title) { toast('Başlıq yazın', true); return; }
      if (!sb) return;

      const { error } = await sb.from('news_posts')
        .insert({ title, body: body || null, sort_order: order, active: true });

      if (error) { toast('Xəta: ' + error.message, true); return; }
      logAudit('Xəbər əlavə edildi', title);
      document.getElementById('new-news-title').value = '';
      document.getElementById('new-news-body').value = '';
      toast('✓ Xəbər əlavə edildi');
      loadNewsAdmin();
      loadNews();
    });

    /* ═══════════════════════════════════════════════════════════
       ADMIN — SINAQ NƏTİCƏLƏRİ
       Admin/staff bir tələbəni ad/email ilə axtarıb sınaq nəticəsi
       əlavə edir; bu, avtomatik olaraq həmin tələbənin bildiriş
       panelinə (fetchExamResults → buildNotifCache) düşür.
    ═══════════════════════════════════════════════════════════ */
    async function loadExamResultsAdmin() {
      const listEl = document.getElementById('admin-examresults-list');
      listEl.innerHTML = '<div class="skeleton-card"><div class="skeleton skeleton-line wide"></div><div class="skeleton skeleton-line narrow"></div></div>'.repeat(3);

      if (!sb) { listEl.innerHTML = '<div class="admin-empty"><span class="empty-icon">⚠️</span>Supabase bağlantısı yoxdur.</div>'; return; }

      profilesNameCache = null;
      await loadProfilesCache();
      const dl = document.getElementById('examresult-search-datalist');
      if (dl && profilesNameCache) {
        dl.innerHTML = Object.entries(profilesNameCache)
          .filter(([email, name]) => name)
          .map(([email, name]) => `<option value="${escapeHtml(name)} — ${escapeHtml(email)}">`)
          .join('');
      }

      const { data, error } = await sb.from('exam_results')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);

      if (error) {
        listEl.innerHTML = `
          <div class="admin-empty" style="text-align:left; padding:16px;">
            <span class="empty-icon">❌</span>
            <b>Cədvəl tapılmadı</b><br>
            <span style="font-size:12px; color:var(--ink-soft);">${escapeHtml(error.message)}</span><br><br>
            <span style="font-size:11px; color:var(--ink-soft);">
              <b>supabase-security-setup.sql</b> faylını Supabase → SQL Editor-da icra edin.</span>
          </div>`;
        return;
      }

      if (!data || !data.length) {
        listEl.innerHTML = '<div class="admin-empty"><span class="empty-icon">📊</span>Hələ sınaq nəticəsi əlavə edilməyib.</div>';
        return;
      }

      const card = document.createElement('div');
      card.className = 'admin-card';
      data.forEach(r => {
        const studentName = (profilesNameCache && profilesNameCache[r.student_email]) || '';
        const row = document.createElement('div');
        row.className = 'admin-card-row';
        row.innerHTML = `
          <div class="admin-card-row-info">
            <p class="admin-row-name">${escapeHtml(r.exam_name)} — ${escapeHtml(r.result_text)}</p>
            <p class="admin-row-sub">${escapeHtml(studentName ? studentName + ' — ' + r.student_email : r.student_email)}${r.created_at ? ' · ' + new Date(r.created_at).toLocaleDateString('az-AZ') : ''}</p>
          </div>
          <div style="display:flex; gap:6px; align-items:center; flex-shrink:0;">
            <button class="admin-action-btn danger del-examresult" data-id="${r.id}">Sil</button>
          </div>`;
        card.appendChild(row);
      });
      listEl.innerHTML = '';
      listEl.appendChild(card);

      listEl.querySelectorAll('.del-examresult').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Bu sınaq nəticəsini silmək istədiyinizə əminsiniz?')) return;
          await sb.from('exam_results').delete().eq('id', btn.dataset.id);
          logAudit('Sınaq nəticəsi silindi', btn.dataset.id);
          toast('✓ Silindi');
          loadExamResultsAdmin();
        });
      });
    }

    document.getElementById('add-examresult-btn')?.addEventListener('click', async () => {
      const raw = document.getElementById('new-examresult-search').value.trim();
      const examName = document.getElementById('new-examresult-name').value.trim();
      const resultText = document.getElementById('new-examresult-value').value.trim();
      const email = extractEmailFromStaffInput(raw);
      if (!email) { toast('Siyahıdan seçin və ya tam email yazın', true); return; }
      if (!examName || !resultText) { toast('Sınaq adı və nəticəni yazın', true); return; }
      if (!sb) return;

      const btn = document.getElementById('add-examresult-btn');
      btn.disabled = true; btn.textContent = '...';
      const { error } = await sb.from('exam_results')
        .insert({ student_email: email, exam_name: examName, result_text: resultText, created_by: currentEmail });
      btn.disabled = false; btn.textContent = 'Əlavə et';

      if (error) { toast('Xəta: ' + error.message, true); return; }
      logAudit('Sınaq nəticəsi əlavə edildi', email, examName);
      document.getElementById('new-examresult-search').value = '';
      document.getElementById('new-examresult-name').value = '';
      document.getElementById('new-examresult-value').value = '';
      toast('✓ Sınaq nəticəsi əlavə edildi');
      loadExamResultsAdmin();
    });

    /* ═══════════════════════════════════════════════════════════
       ADMIN — ÖDƏNİŞLİ SINAQ İMTAHANLARI
       Kataloq (ad/qiymət/izah) + tələbələrin qeydiyyatları. Ödəniş
       nağd/bank köçürməsi ilə OFFLINE aparılır, burada yalnız statusu
       (gözlənilir/ödənilib) əl ilə qeyd edirik — kart ödənişi YOXDUR.
    ═══════════════════════════════════════════════════════════ */
    async function loadTrialExamsAdmin() {
      const listEl = document.getElementById('admin-trialexams-list');
      listEl.innerHTML = '<div class="skeleton-card"><div class="skeleton skeleton-line wide"></div><div class="skeleton skeleton-line narrow"></div></div>'.repeat(2);

      if (!sb) { listEl.innerHTML = '<div class="admin-empty"><span class="empty-icon">⚠️</span>Supabase bağlantısı yoxdur.</div>'; return; }

      const { data, error } = await sb.from('trial_exams')
        .select('*')
        .order('sort_order', { ascending: true })
        .order('id', { ascending: true });

      if (error) {
        listEl.innerHTML = `
          <div class="admin-empty" style="text-align:left; padding:16px;">
            <span class="empty-icon">❌</span>
            <b>Cədvəl tapılmadı</b><br>
            <span style="font-size:12px; color:var(--ink-soft);">${escapeHtml(error.message)}</span><br><br>
            <span style="font-size:11px; color:var(--ink-soft);">
              <b>supabase-security-setup.sql</b> faylını Supabase → SQL Editor-da icra edin.</span>
          </div>`;
        return;
      }
      if (!data || !data.length) {
        listEl.innerHTML = '<div class="admin-empty"><span class="empty-icon">🎯</span>Hələ sınaq imtahanı əlavə edilməyib.</div>';
        return;
      }

      const card = document.createElement('div');
      card.className = 'admin-card';
      data.forEach(ex => {
        const row = document.createElement('div');
        row.className = 'admin-card-row';
        row.innerHTML = `
          <div class="admin-card-row-info">
            <p class="admin-row-name">${escapeHtml(ex.name)}${ex.active ? '' : ' (gizli)'}</p>
            <p class="admin-row-sub">${ex.price_text ? escapeHtml(ex.price_text) + ' · ' : ''}sıra ${ex.sort_order}</p>
          </div>
          <div style="display:flex; gap:6px; align-items:center; flex-shrink:0; flex-wrap:wrap; justify-content:flex-end;">
            <button class="admin-action-btn trialexam-questions-btn" data-id="${ex.id}" data-name="${escapeHtml(ex.name)}">❓ Suallar</button>
            <button class="admin-action-btn toggle-trialexam" data-id="${ex.id}" data-active="${ex.active}">${ex.active ? 'Gizlət' : 'Göstər'}</button>
            <button class="admin-action-btn danger del-trialexam" data-id="${ex.id}">Sil</button>
          </div>`;
        card.appendChild(row);
      });
      listEl.innerHTML = '';
      listEl.appendChild(card);

      listEl.querySelectorAll('.toggle-trialexam').forEach(btn => {
        btn.addEventListener('click', async () => {
          const newActive = btn.dataset.active !== 'true';
          await sb.from('trial_exams').update({ active: newActive }).eq('id', btn.dataset.id);
          logAudit('Sınaq imtahanı dəyişdirildi', btn.dataset.id, newActive ? 'aktiv' : 'gizli');
          toast('✓ Yeniləndi');
          loadTrialExamsAdmin();
          loadTrialExams();
        });
      });
      listEl.querySelectorAll('.del-trialexam').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Bu sınaq imtahanını silmək istədiyinizə əminsiniz? Bütün qeydiyyatlar da silinəcək.')) return;
          await sb.from('trial_exams').delete().eq('id', btn.dataset.id);
          logAudit('Sınaq imtahanı silindi', btn.dataset.id);
          toast('✓ Silindi');
          loadTrialExamsAdmin();
          loadTrialExams();
          loadTrialExamRegsAdmin();
        });
      });
      listEl.querySelectorAll('.trialexam-questions-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          currentQuestionsExamId = btn.dataset.id;
          document.getElementById('trialexam-questions-title').textContent = 'Sınaq sualları — ' + btn.dataset.name;
          openModal('trialexam-questions-modal');
          loadTrialExamQuestionsAdmin();
        });
      });
    }

    /* ═══════════════════════════════════════════════════════════
       ADMIN — SINAQ SUALLARI (interaktiv sınaq üçün)
    ═══════════════════════════════════════════════════════════ */
    let currentQuestionsExamId = null;

    async function loadTrialExamQuestionsAdmin() {
      const listEl = document.getElementById('admin-trialexam-questions-list');
      if (!currentQuestionsExamId || !sb) return;
      listEl.innerHTML = '<div class="skeleton-card"><div class="skeleton skeleton-line wide"></div><div class="skeleton skeleton-line narrow"></div></div>'.repeat(2);

      const { data, error } = await sb.from('trial_exam_questions')
        .select('*')
        .eq('trial_exam_id', currentQuestionsExamId)
        .order('sort_order', { ascending: true })
        .order('id', { ascending: true });

      if (error) {
        listEl.innerHTML = `
          <div class="admin-empty" style="text-align:left; padding:16px;">
            <span class="empty-icon">❌</span>
            <b>Cədvəl tapılmadı</b><br>
            <span style="font-size:12px; color:var(--ink-soft);">${escapeHtml(error.message)}</span><br><br>
            <span style="font-size:11px; color:var(--ink-soft);">
              <b>supabase-security-setup.sql</b> faylını Supabase → SQL Editor-da icra edin.</span>
          </div>`;
        return;
      }
      if (!data || !data.length) {
        listEl.innerHTML = '<div class="admin-empty"><span class="empty-icon">❓</span>Hələ sual əlavə edilməyib.</div>';
        return;
      }

      const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
      const card = document.createElement('div');
      card.className = 'admin-card';
      data.forEach((q, idx) => {
        const opts = Array.isArray(q.options) ? q.options : [];
        const optsHtml = opts.map((o, i) => `<span style="display:block; ${i === q.correct_index ? 'color:var(--teal); font-weight:600;' : ''}">${i === q.correct_index ? '✓' : letters[i]} ${escapeHtml(o)}</span>`).join('');
        const row = document.createElement('div');
        row.className = 'admin-card-row';
        row.innerHTML = `
          <div class="admin-card-row-info">
            <p class="admin-row-name">${idx + 1}. ${escapeHtml(q.question_text)}</p>
            <div class="admin-row-sub" style="line-height:1.6;">${optsHtml}</div>
          </div>
          <div style="display:flex; gap:6px; align-items:flex-start; flex-shrink:0;">
            <button class="admin-action-btn danger del-question" data-id="${q.id}">Sil</button>
          </div>`;
        card.appendChild(row);
      });
      listEl.innerHTML = '';
      listEl.appendChild(card);

      listEl.querySelectorAll('.del-question').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Bu sualı silmək istədiyinizə əminsiniz?')) return;
          await sb.from('trial_exam_questions').delete().eq('id', btn.dataset.id);
          toast('✓ Sual silindi');
          loadTrialExamQuestionsAdmin();
        });
      });
    }

    document.getElementById('add-question-btn')?.addEventListener('click', async () => {
      if (!sb || !currentQuestionsExamId) return;
      const questionText = document.getElementById('new-question-text').value.trim();
      const opts = [0, 1, 2, 3].map(i => document.getElementById('new-question-opt-' + i).value.trim());
      if (!questionText) { toast('Sual mətnini yazın', true); return; }
      if (opts.some(o => !o)) { toast('Bütün 4 seçimi doldurun', true); return; }
      const correctRadio = document.querySelector('input[name="new-question-correct"]:checked');
      const correctIndex = correctRadio ? parseInt(correctRadio.value, 10) : 0;

      const btn = document.getElementById('add-question-btn');
      btn.disabled = true; btn.textContent = '...';
      const { error } = await sb.from('trial_exam_questions').insert({
        trial_exam_id: parseInt(currentQuestionsExamId, 10),
        question_text: questionText,
        options: opts,
        correct_index: correctIndex
      });
      btn.disabled = false; btn.textContent = 'Sual əlavə et';

      if (error) { toast('Xəta: ' + error.message, true); return; }
      document.getElementById('new-question-text').value = '';
      [0, 1, 2, 3].forEach(i => { document.getElementById('new-question-opt-' + i).value = ''; });
      document.querySelector('input[name="new-question-correct"][value="0"]').checked = true;
      toast('✓ Sual əlavə edildi');
      loadTrialExamQuestionsAdmin();
    });

    document.getElementById('trialexam-questions-close')?.addEventListener('click', () => closeModal('trialexam-questions-modal'));
    document.getElementById('trialexam-questions-modal')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeModal('trialexam-questions-modal');
    });

    document.getElementById('add-trialexam-btn')?.addEventListener('click', async () => {
      const name = document.getElementById('new-trialexam-name').value.trim();
      const price = document.getElementById('new-trialexam-price').value.trim();
      const desc = document.getElementById('new-trialexam-desc').value.trim();
      if (!name) { toast('Ad yazın', true); return; }
      if (!sb) return;

      const { error } = await sb.from('trial_exams')
        .insert({ name, price_text: price || null, description: desc || null, active: true });

      if (error) { toast('Xəta: ' + error.message, true); return; }
      logAudit('Sınaq imtahanı əlavə edildi', name);
      document.getElementById('new-trialexam-name').value = '';
      document.getElementById('new-trialexam-price').value = '';
      document.getElementById('new-trialexam-desc').value = '';
      toast('✓ Sınaq imtahanı əlavə edildi');
      loadTrialExamsAdmin();
      loadTrialExams();
    });

    async function loadTrialExamRegsAdmin() {
      const listEl = document.getElementById('admin-trialexam-regs-list');
      listEl.innerHTML = '<div class="skeleton-card"><div class="skeleton skeleton-line wide"></div><div class="skeleton skeleton-line narrow"></div></div>'.repeat(3);

      if (!sb) { listEl.innerHTML = '<div class="admin-empty"><span class="empty-icon">⚠️</span>Supabase bağlantısı yoxdur.</div>'; return; }

      profilesNameCache = null;
      await loadProfilesCache();

      const { data, error } = await sb.from('trial_exam_registrations')
        .select('*, trial_exams(name)')
        .order('created_at', { ascending: false })
        .limit(100);

      if (error) {
        listEl.innerHTML = `
          <div class="admin-empty" style="text-align:left; padding:16px;">
            <span class="empty-icon">❌</span>
            <b>Cədvəl tapılmadı</b><br>
            <span style="font-size:12px; color:var(--ink-soft);">${escapeHtml(error.message)}</span>
          </div>`;
        return;
      }
      if (!data || !data.length) {
        listEl.innerHTML = '<div class="admin-empty"><span class="empty-icon">🎯</span>Hələ qeydiyyat yoxdur.</div>';
        return;
      }

      const card = document.createElement('div');
      card.className = 'admin-card';
      data.forEach(r => {
        const studentName = (profilesNameCache && profilesNameCache[r.student_email]) || '';
        const examName = (r.trial_exams && r.trial_exams.name) || '—';
        const isPaid = r.payment_status === 'ödənilib';
        const resultLine = trialExamResultLine(r);
        const row = document.createElement('div');
        row.className = 'admin-card-row';
        row.innerHTML = `
          <div class="admin-card-row-info">
            <p class="admin-row-name">${escapeHtml(examName)}</p>
            <p class="admin-row-sub">${escapeHtml(studentName ? studentName + ' — ' + r.student_email : r.student_email)}${r.created_at ? ' · ' + new Date(r.created_at).toLocaleDateString('az-AZ') : ''}</p>
            ${resultLine ? `<p class="admin-row-sub" style="color:var(--teal); font-weight:600;">${escapeHtml(resultLine)}</p>` : ''}
          </div>
          <div style="display:flex; gap:6px; align-items:center; flex-shrink:0; flex-wrap:wrap; justify-content:flex-end;">
            <span class="status-badge ${isPaid ? 'done' : 'pending'}">${isPaid ? 'Ödənilib' : 'Gözlənilir'}</span>
            <button class="admin-action-btn toggle-trialexam-paid" data-id="${r.id}" data-paid="${isPaid}">${isPaid ? '↺ Gözləniləndir' : '✓ Ödənildi et'}</button>
            <button class="admin-action-btn trialexam-result-btn" data-id="${r.id}" data-correct="${r.correct_count ?? ''}" data-wrong="${r.wrong_count ?? ''}" data-total="${r.total_questions ?? ''}" data-exam="${escapeHtml(examName)}" data-student="${escapeHtml(studentName || r.student_email)}">📝 Nəticə</button>
            <button class="admin-action-btn danger del-trialexam-reg" data-id="${r.id}">Sil</button>
          </div>`;
        card.appendChild(row);
      });
      listEl.innerHTML = '';
      listEl.appendChild(card);

      listEl.querySelectorAll('.toggle-trialexam-paid').forEach(btn => {
        btn.addEventListener('click', async () => {
          const newStatus = btn.dataset.paid === 'true' ? 'gözlənilir' : 'ödənilib';
          await sb.from('trial_exam_registrations').update({ payment_status: newStatus }).eq('id', btn.dataset.id);
          logAudit('Sınaq qeydiyyatı ödəniş statusu dəyişdirildi', btn.dataset.id, newStatus);
          toast('✓ Yeniləndi');
          loadTrialExamRegsAdmin();
        });
      });
      listEl.querySelectorAll('.del-trialexam-reg').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Bu qeydiyyatı silmək istədiyinizə əminsiniz?')) return;
          await sb.from('trial_exam_registrations').delete().eq('id', btn.dataset.id);
          logAudit('Sınaq qeydiyyatı silindi', btn.dataset.id);
          toast('✓ Silindi');
          loadTrialExamRegsAdmin();
        });
      });
      listEl.querySelectorAll('.trialexam-result-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          trialExamResultRegId = btn.dataset.id;
          document.getElementById('trialexam-result-subtitle').textContent = `${btn.dataset.exam} — ${btn.dataset.student}`;
          document.getElementById('trialexam-result-correct').value = btn.dataset.correct;
          document.getElementById('trialexam-result-wrong').value = btn.dataset.wrong;
          document.getElementById('trialexam-result-total').value = btn.dataset.total;
          openModal('trialexam-result-modal');
        });
      });
    }

    // Doğru/səhv/ümumi say ilə faiz hesablayıb qısa xülasə sətri hazırlayır —
    // həm admin siyahısında, həm tələbə kataloqunda, həm bildirişdə istifadə olunur.
    function trialExamResultLine(r) {
      if (r.total_questions === null || r.total_questions === undefined) return '';
      const correct = r.correct_count || 0;
      const pct = r.total_questions ? Math.round(correct / r.total_questions * 100) : 0;
      const wrongPart = (r.wrong_count !== null && r.wrong_count !== undefined) ? `, ${r.wrong_count} ${t('trialexams_wrong_short', 'səhv')}` : '';
      return `${correct}/${r.total_questions} ${t('trialexams_correct_short', 'doğru')} (${pct}%)${wrongPart}`;
    }

    let trialExamResultRegId = null;
    document.getElementById('trialexam-result-save-btn')?.addEventListener('click', async () => {
      if (!sb || !trialExamResultRegId) return;
      const correctVal = document.getElementById('trialexam-result-correct').value;
      const wrongVal = document.getElementById('trialexam-result-wrong').value;
      const totalVal = document.getElementById('trialexam-result-total').value;
      if (totalVal === '') { toast('Ümumi sual sayını yazın', true); return; }
      const payload = {
        correct_count: correctVal === '' ? null : parseInt(correctVal, 10),
        wrong_count: wrongVal === '' ? null : parseInt(wrongVal, 10),
        total_questions: parseInt(totalVal, 10)
      };
      await sb.from('trial_exam_registrations').update(payload).eq('id', trialExamResultRegId);
      logAudit('Sınaq nəticəsi əlavə edildi', trialExamResultRegId);
      toast('✓ Nəticə yadda saxlanıldı');
      closeModal('trialexam-result-modal');
      loadTrialExamRegsAdmin();
    });
    document.getElementById('trialexam-result-cancel-btn')?.addEventListener('click', () => closeModal('trialexam-result-modal'));
    document.getElementById('trialexam-result-modal')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeModal('trialexam-result-modal');
    });

    /* ═══════════════════════════════════════════════════════════
       ADMIN — ANALİTİKA
       Bütün göstəricilər mövcud cədvəllərdən (profiles / consultations /
       document_status) müştəri tərəfində hesablanır — əlavə cədvəl lazım deyil.
    ═══════════════════════════════════════════════════════════ */
    function barListHtml(pairs, total, emptyText) {
      if (!pairs.length) return `<p class="admin-row-sub" style="margin:0;">${emptyText}</p>`;
      const max = Math.max(...pairs.map(p => p[1])) || 1;
      return pairs.map(([label, count]) => {
        const pct = total ? Math.round(count / total * 100) : 0;
        return `
        <div style="margin-bottom:10px;">
          <div style="display:flex; justify-content:space-between; font-size:12px; margin-bottom:4px;">
            <span style="color:var(--ink);">${escapeHtml(label)}</span>
            <span style="color:var(--ink-soft); font-variant-numeric:tabular-nums;">${count} · ${pct}%</span>
          </div>
          <div class="progress-track" style="margin:0;">
            <div class="progress-fill" style="width:${Math.round(count / max * 100)}%;"></div>
          </div>
        </div>`;
      }).join('');
    }

    function countValues(rows, field) {
      const counts = {};
      rows.forEach(r => {
        let v = r[field];
        if (!v) return;
        if (!Array.isArray(v)) v = [v];
        v.forEach(x => { if (x) counts[x] = (counts[x] || 0) + 1; });
      });
      return Object.entries(counts).sort((a, b) => b[1] - a[1]);
    }

    async function loadAnalytics() {
      const setLoading = (id) => { const el = document.getElementById(id); if (el) el.innerHTML = '<div class="skeleton skeleton-line wide"></div>'; };
      ['an-countries', 'an-fields', 'an-consults', 'an-weekly'].forEach(setLoading);

      if (!sb) {
        document.getElementById('an-countries').innerHTML = '<p class="admin-row-sub" style="margin:0;">Supabase bağlantısı yoxdur.</p>';
        return;
      }

      const [profRes, consRes] = await Promise.all([
        sb.from('profiles').select('email, role, created_at, target_countries, fields, level, budget'),
        sb.from('consultations').select('profile_email, status, confirmed')
      ]);

      if (profRes.error) {
        document.getElementById('an-countries').innerHTML =
          `<p class="admin-row-sub" style="margin:0;">Məlumat yüklənmədi: ${escapeHtml(profRes.error.message)}</p>`;
        return;
      }

      const students = (profRes.data || []).filter(p =>
        !ADMIN_EMAILS.includes((p.email || '').toLowerCase()) &&
        p.role !== 'admin' && p.role !== 'staff');
      const total = students.length;

      // Profil tamamlama: ölkə + ixtisas + səviyyə doldurulubsa "tamam" sayılır
      const completed = students.filter(p =>
        (p.target_countries && p.target_countries.length) &&
        (p.fields && p.fields.length) && p.level).length;
      document.getElementById('an-completion').textContent =
        total ? Math.round(completed / total * 100) + '%' : '—';

      // Konsultasiyaya keçid: ən azı bir görüş yazan tələbələrin payı
      const consults = consRes.error ? [] : (consRes.data || []);
      const bookedEmails = new Set(consults.map(c => c.profile_email));
      const booked = students.filter(p => bookedEmails.has(p.email)).length;
      document.getElementById('an-conversion').textContent =
        total ? Math.round(booked / total * 100) + '%' : '—';

      document.getElementById('an-countries').innerHTML =
        barListHtml(countValues(students, 'target_countries').slice(0, 8), total, 'Hələ məlumat yoxdur.');
      document.getElementById('an-fields').innerHTML =
        barListHtml(countValues(students, 'fields').slice(0, 8), total, 'Hələ məlumat yoxdur.');

      // Konsultasiya vəziyyəti
      const statusCounts = { 'Gözləyir': 0, 'Təsdiqləndi': 0, 'Rədd edildi': 0 };
      consults.forEach(c => { statusCounts[apptStatusMeta(c).label] = (statusCounts[apptStatusMeta(c).label] || 0) + 1; });
      document.getElementById('an-consults').innerHTML =
        barListHtml(Object.entries(statusCounts).filter(e => e[1] > 0), consults.length, 'Hələ görüş yoxdur.');

      // Son 6 həftə üzrə qeydiyyat
      const weeks = [];
      for (let i = 5; i >= 0; i--) {
        const end = new Date(); end.setHours(0, 0, 0, 0); end.setDate(end.getDate() - i * 7);
        const start = new Date(end); start.setDate(start.getDate() - 7);
        const count = students.filter(p => {
          if (!p.created_at) return false;
          const d = new Date(p.created_at);
          return d > start && d <= end;
        }).length;
        weeks.push([i === 0 ? 'Bu həftə' : `${i} həftə əvvəl`, count]);
      }
      const weeklyTotal = weeks.reduce((s, w) => s + w[1], 0);
      document.getElementById('an-weekly').innerHTML =
        barListHtml(weeks, weeklyTotal, 'Hələ qeydiyyat yoxdur.');
    }

    // ── Tələbə Axtarışı ───────────────────────────────────────
    document.getElementById('student-search').addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      if (!q) { renderStudentList(allStudentsCache); return; }
      const filtered = allStudentsCache.filter(s =>
        (s.name || '').toLowerCase().includes(q) ||
        (s.email || '').toLowerCase().includes(q) ||
        (Array.isArray(s.target_countries) ? s.target_countries.join(' ') : (s.target_countries || '')).toLowerCase().includes(q)
      );
      renderStudentList(filtered);
    });

    document.getElementById('export-students-csv')?.addEventListener('click', () => {
      if (!allStudentsCache.length) { toast('İxrac ediləcək tələbə yoxdur', true); return; }
      const rows = allStudentsCache.map(s => [
        s.name || '', s.email || '',
        Array.isArray(s.target_countries) ? s.target_countries.join('; ') : (s.target_countries || ''),
        Array.isArray(s.target_universities) ? s.target_universities.join('; ') : (s.target_universities || ''),
        s.level || '', s.budget || '', s.score || '', s.student_status || 'active',
        s.created_at ? new Date(s.created_at).toLocaleDateString('az-AZ') : ''
      ]);
      downloadCSV('telebeler.csv',
        ['Ad Soyad', 'Email', 'Hədəf ölkə', 'Hədəf universitet', 'Səviyyə', 'Büdcə', 'Bal', 'Status', 'Qeydiyyat tarixi'],
        rows);
    });

    document.getElementById('export-appointments-csv')?.addEventListener('click', () => {
      if (!lastAppointmentsData.length) { toast('İxrac ediləcək görüş yoxdur', true); return; }
      const rows = lastAppointmentsData.map(a => [
        a.profile_email || '', a.advisor_name || '', a.date || '', a.time || '',
        apptStatusMeta(a).label, a.admin_note || '',
        a.created_at ? new Date(a.created_at).toLocaleString('az-AZ') : ''
      ]);
      downloadCSV('konsultasiyalar.csv',
        ['Tələbə email', 'Məsləhətçi', 'Tarix', 'Saat', 'Status', 'Admin qeydi', 'Yaradılıb'],
        rows);
    });

    document.getElementById('export-documents-csv')?.addEventListener('click', () => {
      if (!lastDocumentsData.length) { toast('İxrac ediləcək sənəd yoxdur', true); return; }
      const rows = lastDocumentsData.map(d => [
        d.profile_email || '', d.doc_name || '', d.status || '',
        d.uploaded_at ? new Date(d.uploaded_at).toLocaleDateString('az-AZ') : ''
      ]);
      downloadCSV('senedler.csv',
        ['Tələbə email', 'Sənəd adı', 'Status', 'Yükləndiyi tarix'],
        rows);
    });

    // ── Konsultasiya Filtri (məsləhətçi + tarix aralığı) ───────
    document.getElementById('appt-filter').addEventListener('change', (e) => {
      loadAppointments(e.target.value);
    });
    document.getElementById('appt-date-from').addEventListener('change', () => {
      loadAppointments(document.getElementById('appt-filter').value);
    });
    document.getElementById('appt-date-to').addEventListener('change', () => {
      loadAppointments(document.getElementById('appt-filter').value);
    });

    // ── Sənəd Ad Soyad Filtri ─────────────────────────────────
    let docFilterTimeout;
    document.getElementById('doc-name-filter').addEventListener('input', (e) => {
      clearTimeout(docFilterTimeout);
      docFilterTimeout = setTimeout(() => {
        profilesNameCache = null; // Cache-i sıfırla ki, yeni məlumat gəlsin
        loadAdminDocuments(e.target.value.trim());
      }, 400);
    });



    // ── İşçi Əlavə Et — ad/soyad və ya email ilə axtarıb tapmaq ──
    // Xanaya ya birbaşa email, ya da datalist-dən "Ad Soyad — email" seçimi
    // yazıla bilər; hər iki halda faktiki emaili reqex ilə çıxarırıq.
    function extractEmailFromStaffInput(raw) {
      const match = (raw || '').match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
      return match ? match[0] : null;
    }

    document.getElementById('add-staff-btn').addEventListener('click', async () => {
      const raw = document.getElementById('new-staff-search').value.trim();
      const role = document.getElementById('new-staff-role').value;
      const email = extractEmailFromStaffInput(raw);
      if (!email) { toast('Siyahıdan seçin və ya tam email yazın', true); return; }
      document.getElementById('add-staff-btn').textContent = '...';
      await addStaffMember(email, role);
      document.getElementById('new-staff-search').value = '';
      document.getElementById('add-staff-btn').textContent = 'Əlavə et';
    });

    // ── İşçi Sil — Təsdiq ─────────────────────────────────────
    document.getElementById('staff-delete-confirm-btn').addEventListener('click', async () => {
      if (!staffToDelete || !sb) return;
      await sb.from('profiles').update({ role: 'student' }).eq('email', staffToDelete);
      logAudit('İşçi silindi', staffToDelete);
      staffToDelete = null;
      closeModal('staff-delete-modal');
      toast('✓ İşçi silindi (rolu tələbəyə qaytarıldı)');
      loadStaff();
    });
    document.getElementById('staff-delete-cancel-btn').addEventListener('click', () => closeModal('staff-delete-modal'));

    // ── Modal Bağlama ─────────────────────────────────────────
    document.getElementById('modal-close-btn').addEventListener('click', () => closeModal('student-modal'));
    document.getElementById('appt-modal-close-btn').addEventListener('click', () => closeModal('appt-modal'));

    // Overlay-ə klik edib bağla
    document.getElementById('student-modal').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeModal('student-modal');
    });
    document.getElementById('appt-modal').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeModal('appt-modal');
    });
    document.getElementById('staff-delete-modal').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeModal('staff-delete-modal');
    });

    // ── Admin Çıxış ───────────────────────────────────────────
    document.getElementById('admin-logout-btn').addEventListener('click', async () => {
      if (sb) await sb.auth.signOut();
      window.location.reload();
    });

    // ── Admin Rol Yoxlaması artıq birbaşa login/register/splash handler-lərinin içindədir ──

    /* ═══════════════════════════════════════════════════════════
       PWA — Service Worker qeydiyyatı (offline dəstək)
    ═══════════════════════════════════════════════════════════ */
    if ('serviceWorker' in navigator && window.location.protocol !== 'file:') {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW qeydiyyatı alınmadı:', err));
      });
    }

