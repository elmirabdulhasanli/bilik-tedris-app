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

    const sb = (typeof window.supabase !== 'undefined' && SUPABASE_URL !== 'YOUR_SUPABASE_URL')
      ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
      : null;

    /* Şifrə bərpası və valideyn linki kimi e-poçtla göndərilən ünvanlar
       üçün sabit kök — window.location-dan asılı deyil, yerli testdə də
       düzgün canlı ünvanı yazır. */
    const PRODUCTION_URL = 'https://bilik-xaricde-tehsil.netlify.app/';

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

    /* ── Admin panelindən qalan ortaq köməkçilər ──────────────
       Bu saytda admin paneli yoxdur, amma aşağıdakılar tələbənin öz
       görüş siyahısı və valideyn görünüşü tərəfindən işlədilir. */
    // `status` sütunu yoxdursa (köhnə sətirlər) köhnə `confirmed` boolean-a geri qayıdır.
    function apptStatusMeta(appt) {
      const status = appt.status || (appt.confirmed ? 'confirmed' : 'pending');
      if (status === 'confirmed') return { label: 'Təsdiqləndi', cls: 'done', status };
      if (status === 'rejected') return { label: 'Rədd edildi', cls: 'rejected', status };
      return { label: 'Gözləyir', cls: 'pending', status: 'pending' };
    }
    // ── Köməkçi: Modal aç/bağla ───────────────────────────────
    function openModal(id) {
      document.getElementById(id).classList.add('open');
    }
    function closeModal(id) {
      document.getElementById(id).classList.remove('open');
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

    /* ── Supabase DB funksiyaları ─────────────────────────── */
    async function dbSaveProfile(data) {
      if (!sb) return { data: null, error: null };
      const result = await sb.from('profiles')
        .upsert({
          /* Mənbə HƏR yazıda göndərilir, çünki profil sətrini yaradan bir neçə
             yol var: onboarding formu, qeydiyyat və universitet seçimi
             (tələbə formu doldurmadan da universitet seçə bilir). Hansı yol
             sətri birinci yaradırsa, damğa düzgün düşməlidir.
             Mövcud sətirdə bazadakı trg_prevent_source_change triggeri köhnə
             dəyəri saxlayır — yəni bu sətir heç vaxt mənbəni sürüşdürmür. */
          source: 'xaric',
          ...data,
          updated_at: new Date().toISOString()
        }, { onConflict: 'email' })
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

    // Ana ekrandakı məzmun kartları bu saytda yoxdur — qəbullar açılış səhifəsində
    // inline göstərilir, ona görə kart/modal bağlamalarına ehtiyac qalmayıb.

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
      // Aktiv vəziyyət klikləniən düyməyə deyil, HƏDƏFƏ görə qoyulur:
      // eyni hədəfi həm yuxarı menyu, həm alt zolaq, həm də hero düyməsi daşıyır.
      navBtns.forEach(b => b.classList.toggle('active', b.dataset.target === btn.dataset.target));
      screens.forEach(s => s.classList.remove('active'));
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
      window.scrollTo(0, 0);
      // Menyunu da uyğunlaşdır — ekran proqramla dəyişəndə də doğru bənd işıqlansın.
      navBtns.forEach(b => b.classList.toggle('active', b.dataset.target === id));
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

    /* Hesabda ad yoxdursa e-poçtun @-dan əvvəlki hissəsi işlədilir —
       ekranda "Salam, undefined" görünməsin deyə. */
    async function resolveDisplayName(email, metaName) {
      if (metaName && metaName.trim()) return metaName.trim();
      if (sb && email) {
        try {
          const { data } = await sb.from('profiles').select('name').eq('email', email).maybeSingle();
          if (data && data.name && data.name.trim()) return data.name.trim();
        } catch (e) { /* profil hələ yoxdur — e-poçtdan düzəldirik */ }
      }
      return (email || '').split('@')[0] || 'Tələbə';
    }

    /* Şəbəkə və ya Supabase cavab verməzsə sorğunun sonsuz gözləməsinin
       qarşısını alır — əks halda düymədəki spinner əbədi fırlanır. */
    function withTimeout(promise, ms = 15000) {
      return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Şəbəkə cavab vermədi')), ms))
      ]);
    }

    /* ═══════════════════════════════════════════════════════════
       GİRİŞ AXINI — qeydiyyatsız
       ──────────────────────────────────────────────────────────
       Bu saytda qeydiyyat ekranı yoxdur: müraciət formunun özü
       hesabı yaradır. Səbəb — şəhərdən kənardakı adam üçün "əvvəlcə
       hesab aç, sonra form doldur" artıq bir maneədir, halbuki
       formda onsuz da e-poçtunu yazır.

       Niyə ümumiyyətlə hesab lazımdır: bazadakı bütün qoruma
       qaydaları (RLS) auth.email() üzərindədir — sənəd yükləmək,
       görüş yaratmaq və öz məlumatını görmək yalnız daxil olmuş
       istifadəçiyə mümkündür. Hesab arxa planda yaranır, istifadəçi
       bunu görmür.

       Qayıdış: şifrə yoxdur, e-poçta gələn birdəfəlik link ilə.
    ═══════════════════════════════════════════════════════════ */

    /* Hesab üçün təsadüfi şifrə — istifadəçi onu heç vaxt görmür və
       yazmır, qayıdış e-poçt linki ilə olur. crypto istifadə olunur ki,
       şifrə proqnozlaşdırıla bilməsin. */
    function generatePassword() {
      const bytes = new Uint8Array(24);
      crypto.getRandomValues(bytes);
      return 'Bx' + btoa(String.fromCharCode(...bytes)).replace(/[^A-Za-z0-9]/g, '') + '9!';
    }

    async function sendMagicLink(email) {
      return withTimeout(sb.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: PRODUCTION_URL }
      }));
    }

    /* Müraciət göndərilməzdən əvvəl sessiyanın olmasını təmin edir.
       Qaytarır: { state: 'ok' | 'confirm' | 'existing' | 'error' } */
    async function ensureApplicantSession(email, name) {
      if (!sb) return { state: 'error', message: 'Baza bağlantısı yoxdur.' };

      const { data: { session } } = await withTimeout(sb.auth.getSession());
      if (session) return { state: 'ok' };

      let data = null, error = null;
      try {
        ({ data, error } = await withTimeout(sb.auth.signUp({
          email,
          password: generatePassword(),
          options: { data: { full_name: name } }
        })));
      } catch (e) {
        console.error('Hesab yaratma xətası:', e);
        return { state: 'error', message: t('start_connection_error', 'Serverə qoşulmaq alınmadı.') };
      }

      if (!error) {
        // Supabase-də "Confirm email" söndürülübsə sessiya dərhal gəlir və
        // istifadəçi axını kəsmədən davam edir. Açıqdırsa sessiya gəlmir —
        // onda təsdiq e-poçtu gözlənilir.
        return { state: data && data.session ? 'ok' : 'confirm' };
      }

      // Bu e-poçtla artıq müraciət var — şifrə soruşmaq əvəzinə giriş linki göndəririk.
      if (/already|registered|exists|duplicate/i.test(error.message || '')) {
        try { await sendMagicLink(email); } catch (e) { console.warn('Giriş linki göndərilmədi:', e); }
        return { state: 'existing' };
      }
      return { state: 'error', message: error.message };
    }

    /* Sessiya hazır olandan sonra tətbiqi müraciətçi üçün qurur. */
    async function enterAsApplicant(email, fullName) {
      currentEmail = email;
      document.body.classList.add('is-signed-in');

      const name = await resolveDisplayName(email, fullName);
      const first = (name || '').split(' ')[0] || '';
      document.getElementById('home-greeting').textContent = 'Salam, ' + first;
      document.getElementById('profile-name-display').textContent = name;
      document.getElementById('profile-avatar-initials').textContent = (name || '?').charAt(0).toUpperCase();
      document.getElementById('profile-email-display').textContent = email;
      document.getElementById('f-name').value = name;
      document.getElementById('f-email').value = email;

      // Məzmun cədvəlləri yalnız daxil olmuş istifadəçiyə açıqdır — indi yenidən oxu.
      reloadSharedContent();
      fetchDocumentsStatus(email);
      if (typeof restoreProfile === 'function') await restoreProfile(email);
      if (typeof loadMyConsultations === 'function') loadMyConsultations();
    }

    /* ── Açılış ───────────────────────────────────────────────
       Sessiya varsa birbaşa iş ekranına, yoxsa açılış səhifəsinə. */
    (async function bootstrapSite() {
      if (!sb) { showScreen('splash'); return; }
      try {
        const { data: { session } } = await withTimeout(sb.auth.getSession());
        if (session && session.user) {
          await enterAsApplicant(session.user.email, session.user.user_metadata && session.user.user_metadata.full_name);
          showScreen('home');
        } else {
          showScreen('splash');
        }
      } catch (e) {
        console.error('Başlanğıc xətası:', e);
        toast(t('start_connection_error', 'Serverə qoşulmaq alınmadı. İnternet bağlantınızı yoxlayıb yenidən cəhd edin.'), true);
        showScreen('splash');
      }
    })();

    /* E-poçt linki ilə qayıdanda Supabase sessiyanı URL-dən oxuyur və
       bu hadisəni göndərir — səhifəni yeniləmədən içəri buraxırıq. */
    if (sb) {
      sb.auth.onAuthStateChange(async (event, session) => {
        if (event === 'SIGNED_IN' && session && session.user && !currentEmail) {
          await enterAsApplicant(session.user.email, session.user.user_metadata && session.user.user_metadata.full_name);
          showScreen('home');
          toast('✓ ' + t('return_welcome', 'Xoş gəldiniz!'));
        }
      });
    }

    /* ── Qayıdış ekranı (şifrəsiz giriş linki) ───────────────── */
    document.getElementById('hero-returning-btn')?.addEventListener('click', () => showScreen('login'));
    document.getElementById('magic-back-btn')?.addEventListener('click', () => showScreen('splash'));

    document.getElementById('magic-send-btn')?.addEventListener('click', async () => {
      const email = (document.getElementById('magic-email').value || '').trim().toLowerCase();
      const errEl = document.getElementById('magic-error');
      const okEl = document.getElementById('magic-success');
      const btn = document.getElementById('magic-send-btn');
      errEl.style.display = 'none';
      okEl.style.display = 'none';

      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        errEl.textContent = t('return_bad_email', 'Düzgün e-poçt ünvanı yazın.');
        errEl.style.display = 'block';
        return;
      }
      if (!sb) { errEl.textContent = 'Baza bağlantısı yoxdur.'; errEl.style.display = 'block'; return; }

      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>' + t('return_sending', 'Göndərilir...');
      try {
        const { error } = await sendMagicLink(email);
        if (error) throw error;
        okEl.textContent = t('return_sent', 'Link göndərildi. Poçt qutunuzu yoxlayın — linkə basanda birbaşa müraciətinizə düşəcəksiniz.');
        okEl.style.display = 'block';
      } catch (e) {
        console.error('Giriş linki xətası:', e);
        errEl.textContent = t('start_connection_error', 'Serverə qoşulmaq alınmadı. İnternet bağlantınızı yoxlayıb yenidən cəhd edin.');
        errEl.style.display = 'block';
      } finally {
        btn.disabled = false;
        btn.textContent = t('return_send', 'Giriş linki göndər');
      }
    });

    /* Çıxış — profil ekranından */
    document.getElementById('profile-logout-btn')?.addEventListener('click', async () => {
      if (sb) await sb.auth.signOut();
      window.location.reload();
    });

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

    /* Ümumi məzmunu (xidmətlər, komanda, nailiyyətlər, tərəfdaşlar, xəbərlər,
       sınaq imtahanları, universitet kataloqu) bazadan yenidən oxuyur.

       ƏHƏMİYYƏTLİ: bu cədvəllərin RLS siyasəti yalnız `authenticated` rola
       oxumağa icazə verir. Səhifə ilk açılanda istifadəçi hələ daxil olmayıb,
       ona görə sorğular boş qayıdır. Giriş uğurlu olan kimi bu funksiya
       yenidən çağırılmalıdır — əks halda tələbə daxil olduqdan sonra ekranlar
       "məlumat yoxdur" göstərir və yalnız səhifəni yeniləyəndə dolurdu. */
    function reloadSharedContent() {
      loadUniversitiesFromDB();
      loadAchievements();
    }
    window.__reloadSharedContent = reloadSharedContent;

    // Kataloqu bazadan yenilə (varsa) — səhifə açılışını bloklamadan
    reloadSharedContent();

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

            let error = null;
            try {
              // Fayl böyük ola bilər — yükləmə üçün daha uzun vaxt verilir.
              ({ error } = await withTimeout(sb.storage.from('Documents').upload(fileName, file), 120000));
            } catch (e) {
              console.error('Sənəd yükləmə xətası:', e);
              error = { message: t('start_connection_error', 'Serverə qoşulmaq alınmadı. İnternet bağlantınızı yoxlayıb yenidən cəhd edin.') };
            }
            if (error) {
              toast('Xəta: ' + error.message, true);
              console.error('Supabase Storage Error:', error);
              stamp.className = 'stamp pending';
              stamp.innerHTML = '&#9675;';
              inp.value = '';
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
          try {
            await withTimeout(dbSaveDocStatus(currentEmail, docName, 'done', fileUrl));
            if (currentEmail) toast('✓ Sənəd uğurla bazaya yükləndi');
          } catch (e) {
            console.error('Sənəd statusu yazıla bilmədi:', e);
            toast(t('start_connection_error', 'Serverə qoşulmaq alınmadı. İnternet bağlantınızı yoxlayıb yenidən cəhd edin.'), true);
          }
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
        try {
          const taken = await withTimeout(isSlotTaken(advisorBase, date, time));
          if (taken) {
            msg.style.display = 'block'; msg.style.color = 'var(--coral)';
            msg.textContent = 'Bu tarix və saat üçün artıq başqa görüş var. Zəhmət olmasa başqa saat və ya gün seçin.';
            return;
          }

          btn.innerHTML = '<span class="spinner"></span>Saxlanılır...';
          const { error } = await withTimeout(dbSaveConsultation(currentEmail, advisor, date, time));
          if (error) { msg.style.display = 'block'; msg.style.color = 'var(--coral)'; msg.textContent = 'Xəta baş verdi.'; return; }
          msg.style.display = 'block'; msg.style.color = 'var(--teal)';
          msg.textContent = 'Görüş planlaşdırıldı: ' + date + ', saat ' + time + ' (' + type + ').';
          if (currentEmail) toast('✓ Görüş Supabase-ə saxlanıldı!');
          loadMyConsultations();
        } catch (e) {
          console.error('Görüş yazma xətası:', e);
          msg.style.display = 'block'; msg.style.color = 'var(--coral)';
          msg.textContent = t('start_connection_error', 'Serverə qoşulmaq alınmadı. İnternet bağlantınızı yoxlayıb yenidən cəhd edin.');
        } finally {
          btn.disabled = false; btn.innerHTML = 'Görüşü təsdiqlə';
        }
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
      <div class="card uni-card" data-uni="${escapeHtml(e.name)}" style="cursor:pointer;">
        <div class="uni-row">
          <div>
            <p class="uni-name">${escapeHtml(e.name)}</p>
            <p class="uni-loc">${escapeHtml(e.country)} · ${deptCount} ixtisas mövcuddur</p>
          </div>
          ${hasProfile ? `<div class="match">${e.score}% uyğun</div>` : ''}
        </div>
        <div class="uni-tags"><span class="tag" style="${isSelected ? 'background:var(--navy); color:var(--gold);' : ''}">${isSelected ? '✓ Seçilib' : 'Seçmək üçün toxun'}</span></div>
        <div class="compare-check${isComparing ? ' sel' : ''}" data-compare-uni="${escapeHtml(e.name)}">
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
      rows += `<tr><th>Universitet</th>${unis.map(u => `<th>${escapeHtml(u.name)}</th>`).join('')}</tr>`;

      const dataRow = (label, fn) => `<tr><td>${label}</td>${unis.map(fn).join('')}</tr>`;

      let body = '';
      body += dataRow('Ölkə', u => `<td>${escapeHtml(u.country)}</td>`);
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
          <button class="compare-remove-btn" data-remove-uni="${escapeHtml(u.name)}">Çıxar</button>
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

      const btn = document.getElementById('submit-onboarding');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>' + t('apply_sending', 'Göndərilir...');

      try {
        /* Müraciəti saxlamazdan əvvəl sessiya lazımdır: bazadakı bütün yazma
           icazələri auth.email() üzərindədir. İstifadəçi qeydiyyat ekranı
           görmür — hesab məhz burada, formdakı e-poçtla yaradılır. */
        const sess = await ensureApplicantSession(email, name);

        if (sess.state === 'error') {
          toast('⚠️ ' + (sess.message || 'Xəta baş verdi'), true);
          return;
        }

        if (sess.state === 'confirm' || sess.state === 'existing') {
          /* Sessiya yoxdur — ya e-poçt təsdiqi açıqdır, ya da bu ünvanla
             əvvəl müraciət olunub. Hər iki halda link göndərilib.
             Yazdıqları itməsin deyə qaralama SAXLANILIR. */
          saveOnboardingDraft();
          showScreen('onboarding-result');
          const note = document.getElementById('r-note');
          if (note) {
            note.innerHTML = '<p class="uni-name" style="margin-bottom:4px;">' +
              escapeHtml(t('apply_check_mail_title', 'E-poçtunuzu yoxlayın')) + '</p>' +
              '<p class="uni-loc" style="margin-bottom:0;">' +
              escapeHtml(t('apply_check_mail_sub', 'Müraciətinizi tamamlamaq üçün poçtunuza göndərdiyimiz linkə basın. Yazdıqlarınız itməyib — linkə basandan sonra davam edəcəksiniz.')) +
              '</p>';
          }
          toast(t('apply_check_mail_toast', 'Poçtunuza təsdiq linki göndərdik.'));
          return;
        }

        // sess.state === 'ok' — sessiya var, müraciəti yazırıq
        const { error } = await withTimeout(dbSaveProfile({
          name, father_name: fatherName || null, email, phone,
          target_countries: selCountries,
          target_universities: selUnis,
          fields: selFields,
          level, exams, score, budget
          // `source` dbSaveProfile-ın özündə əlavə olunur — bütün yollar üçün.
        }));

        if (error) { toast('⚠️ Xəta: ' + error.message, true); return; }

        currentEmail = email;
        document.body.classList.add('is-signed-in');
        clearOnboardingDraft();
        showScreen('onboarding-result');
        toast('✓ ' + t('apply_saved', 'Müraciətiniz qəbul edildi!'));
        if (typeof loadMyConsultations === 'function') loadMyConsultations();
        fetchDocumentsStatus(email);
      } catch (e) {
        console.error('Müraciət xətası:', e);
        toast(t('start_connection_error', 'Serverə qoşulmaq alınmadı. İnternet bağlantınızı yoxlayıb yenidən cəhd edin.'), true);
      } finally {
        btn.disabled = false;
        btn.textContent = t('apply_submit', 'Müraciəti göndər');
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

    // Telefon status zolağındakı saat bu saytda yoxdur — blok çıxarılıb.

    /* ═══════════════════════════════════════════════════════════
       DİL DƏYİŞMƏ SİSTEMİ (i18n)
    ═══════════════════════════════════════════════════════════ */
    const translations = {
      az: {
        page_title: 'BTM - Xaricdə Təhsil',
        brand_sub: 'Xaricdə Təhsil',
        hero_title: 'Xaricdə təhsil müraciətini buradan başla',
        hero_sub: 'Universitet seçimindən sənədlərin təhvilinə qədər hamısı onlayn. Şəhərdən və ya ölkədən kənardasınızsa, mərkəzə gəlməyə ehtiyac yoxdur.',
        hero_cta: 'Müraciətə başla',
        hero_returning: 'Daha əvvəl müraciət etmisiniz?',
        hero_card_loc: 'Sumqayıt · Bakı',
        steps_title: 'Necə işləyir',
        step1_t: 'Formu doldurun',
        step1_d: 'Hədəf ölkə, ixtisas, imtahan nəticəsi və büdcə. Qeydiyyat tələb olunmur — form özü müraciətinizdir.',
        step2_t: 'Universitet seçin',
        step2_d: '22 ölkədə 264 universitet. Profilinizə görə uyğunluq faizi hesablanır, seçdiklərinizi yan-yana müqayisə edirsiniz.',
        step3_t: 'Sənədləri göndərin',
        step3_d: 'Telefonla şəkil çəkib yükləyin — skaner lazım deyil. Hər sənədin təsdiq vəziyyətini izləyirsiniz.',
        footer_line: '2007-ci ildən Sumqayıt və Bakıda — xaricdə təhsil üzrə müraciət, sənəd və konsultasiya.',
        return_title: 'Müraciətinizə qayıdın',
        return_sub: 'Müraciət edərkən yazdığınız e-poçt ünvanını daxil edin — giriş linkini ora göndərəcəyik. Şifrə yadda saxlamağa ehtiyac yoxdur.',
        return_send: 'Giriş linki göndər',
        return_sending: 'Göndərilir...',
        return_sent: 'Link göndərildi. Poçt qutunuzu yoxlayın — linkə basanda birbaşa müraciətinizə düşəcəksiniz.',
        return_bad_email: 'Düzgün e-poçt ünvanı yazın.',
        return_back: '← Geri qayıt',
        return_welcome: 'Xoş gəldiniz!',
        apply_submit: 'Müraciəti göndər',
        apply_sending: 'Göndərilir...',
        apply_saved: 'Müraciətiniz qəbul edildi!',
        apply_check_mail_title: 'E-poçtunuzu yoxlayın',
        apply_check_mail_sub: 'Müraciətinizi tamamlamaq üçün poçtunuza göndərdiyimiz linkə basın. Yazdıqlarınız itməyib — linkə basandan sonra davam edəcəksiniz.',
        apply_check_mail_toast: 'Poçtunuza təsdiq linki göndərdik.',
        admin_src_all: 'Hamısı',
        admin_src_kurs: 'Kurs',
        admin_src_abroad: 'Xaricdə təhsil',
        student_badge_abroad: 'Xaric',
        years_with_you: '20 ildir sizinlə',
        // Splash
        splash_tag: 'Xaricdə təhsil marşrutun — universitet seçimindən viza sənədlərinə qədər bir yerdə.',
        splash_start: 'Başla',
        start_connection_error: 'Serverə qoşulmaq alınmadı. İnternet bağlantınızı yoxlayıb yenidən cəhd edin.',
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
        trialexams_review_btn: 'Baxış →',
        trialexams_review_title: 'Təqdim etməzdən əvvəl baxış',
        trialexams_review_back: 'Suallara qayıt',
        trialexams_review_summary_tpl: '{answered}/{total} sual cavablanıb',
        trialexams_exit_confirm: 'Sınaqdan çıxmaq istədiyinizə əminsiniz? Cavablarınız yadda saxlanmayacaq.',
        trialexams_time_expired_title: 'Vaxt bitib',
        trialexams_time_expired_sub: 'Bu sınaq üçün ayrılan vaxt bitdiyi üçün cəhdiniz avtomatik bağlandı. Nəticənizi "Sınaqlar" bölməsində görə bilərsiniz.',
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
        brand_sub: 'Study Abroad',
        hero_title: 'Start your study-abroad application here',
        hero_sub: 'From choosing a university to submitting your documents — all online. If you live outside the city or the country, there is no need to visit the centre.',
        hero_cta: 'Start your application',
        hero_returning: 'Already applied?',
        hero_card_loc: 'Sumgait · Baku',
        steps_title: 'How it works',
        step1_t: 'Fill in the form',
        step1_d: 'Target country, field, exam results and budget. No sign-up needed — the form is your application.',
        step2_t: 'Choose universities',
        step2_d: '264 universities across 22 countries. A match score is calculated from your profile, and you can compare your picks side by side.',
        step3_t: 'Send your documents',
        step3_d: 'Photograph them with your phone and upload — no scanner needed. You can follow the approval status of each document.',
        footer_line: 'In Sumgait and Baku since 2007 — study-abroad applications, documents and consultations.',
        return_title: 'Return to your application',
        return_sub: 'Enter the email address you used when applying — we will send the sign-in link there. No password to remember.',
        return_send: 'Send sign-in link',
        return_sending: 'Sending...',
        return_sent: 'Link sent. Check your inbox — clicking it takes you straight back to your application.',
        return_bad_email: 'Enter a valid email address.',
        return_back: '← Back',
        return_welcome: 'Welcome back!',
        apply_submit: 'Submit application',
        apply_sending: 'Sending...',
        apply_saved: 'Your application has been received!',
        apply_check_mail_title: 'Check your email',
        apply_check_mail_sub: 'Click the link we sent to your inbox to finish your application. Nothing you typed is lost — you will continue right where you left off.',
        apply_check_mail_toast: 'We sent a confirmation link to your email.',
        admin_src_all: 'All',
        admin_src_kurs: 'Courses',
        admin_src_abroad: 'Study abroad',
        student_badge_abroad: 'Abroad',
        years_with_you: '20 years with you',
        splash_tag: 'Your study abroad route — from university selection to visa documents, all in one place.',
        splash_start: 'Start',
        start_connection_error: 'Could not reach the server. Please check your internet connection and try again.',
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
        trialexams_review_btn: 'Review →',
        trialexams_review_title: 'Review before submitting',
        trialexams_review_back: 'Back to questions',
        trialexams_review_summary_tpl: '{answered}/{total} questions answered',
        trialexams_exit_confirm: 'Are you sure you want to leave the exam? Your answers will not be saved.',
        trialexams_time_expired_title: 'Time is up',
        trialexams_time_expired_sub: 'Your attempt was automatically closed because the time allowed for this exam ran out. You can see your result in the "Trial exams" section.',
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
        brand_sub: 'Учёба за рубежом',
        hero_title: 'Начните заявку на учёбу за рубежом',
        hero_sub: 'От выбора университета до подачи документов — всё онлайн. Если вы за пределами города или страны, приезжать в центр не нужно.',
        hero_cta: 'Начать заявку',
        hero_returning: 'Уже подавали заявку?',
        hero_card_loc: 'Сумгаит · Баку',
        steps_title: 'Как это работает',
        step1_t: 'Заполните форму',
        step1_d: 'Страна, специальность, результаты экзаменов и бюджет. Регистрация не нужна — форма и есть ваша заявка.',
        step2_t: 'Выберите университет',
        step2_d: '264 университета в 22 странах. Процент соответствия считается по вашему профилю, выбранные можно сравнить рядом.',
        step3_t: 'Отправьте документы',
        step3_d: 'Сфотографируйте телефоном и загрузите — сканер не нужен. Статус каждого документа виден вам.',
        footer_line: 'С 2007 года в Сумгаите и Баку — заявки на учёбу за рубежом, документы и консультации.',
        return_title: 'Вернитесь к заявке',
        return_sub: 'Введите e-mail, который указали в заявке — мы отправим туда ссылку для входа. Пароль не нужен.',
        return_send: 'Отправить ссылку',
        return_sending: 'Отправляем...',
        return_sent: 'Ссылка отправлена. Проверьте почту — по ней вы сразу попадёте в свою заявку.',
        return_bad_email: 'Введите корректный e-mail.',
        return_back: '← Назад',
        return_welcome: 'С возвращением!',
        apply_submit: 'Отправить заявку',
        apply_sending: 'Отправляем...',
        apply_saved: 'Ваша заявка принята!',
        apply_check_mail_title: 'Проверьте почту',
        apply_check_mail_sub: 'Нажмите ссылку, которую мы отправили на почту, чтобы завершить заявку. Введённое не потеряно — вы продолжите с того же места.',
        apply_check_mail_toast: 'Мы отправили ссылку подтверждения на почту.',
        admin_src_all: 'Все',
        admin_src_kurs: 'Курсы',
        admin_src_abroad: 'Учёба за рубежом',
        student_badge_abroad: 'Зарубеж',
        years_with_you: '20 лет с вами',
        splash_tag: 'Ваш маршрут обучения за рубежом — от выбора университета до визовых документов, всё в одном месте.',
        splash_start: 'Начать',
        start_connection_error: 'Не удалось подключиться к серверу. Проверьте интернет-соединение и попробуйте снова.',
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
        trialexams_review_btn: 'Обзор →',
        trialexams_review_title: 'Проверьте перед отправкой',
        trialexams_review_back: 'Вернуться к вопросам',
        trialexams_review_summary_tpl: 'Отвечено {answered}/{total} вопросов',
        trialexams_exit_confirm: 'Вы уверены, что хотите покинуть экзамен? Ваши ответы не будут сохранены.',
        trialexams_time_expired_title: 'Время истекло',
        trialexams_time_expired_sub: 'Ваша попытка была автоматически завершена, так как время, отведённое на этот экзамен, истекло. Результат можно посмотреть в разделе «Пробные экзамены».',
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
        brand_sub: 'Yurt Dışı Eğitim',
        hero_title: 'Yurt dışı eğitim başvurunu buradan başlat',
        hero_sub: 'Üniversite seçiminden belge teslimine kadar her şey çevrimiçi. Şehir veya ülke dışındaysanız merkeze gelmenize gerek yok.',
        hero_cta: 'Başvuruya başla',
        hero_returning: 'Daha önce başvurdunuz mu?',
        hero_card_loc: 'Sumqayıt · Bakü',
        steps_title: 'Nasıl çalışır',
        step1_t: 'Formu doldurun',
        step1_d: 'Hedef ülke, bölüm, sınav sonucu ve bütçe. Kayıt gerekmez — form zaten başvurunuzdur.',
        step2_t: 'Üniversite seçin',
        step2_d: '22 ülkede 264 üniversite. Profilinize göre uygunluk yüzdesi hesaplanır, seçtiklerinizi yan yana karşılaştırırsınız.',
        step3_t: 'Belgeleri gönderin',
        step3_d: 'Telefonla fotoğraflayıp yükleyin — tarayıcıya gerek yok. Her belgenin onay durumunu takip edersiniz.',
        footer_line: '2007\'den beri Sumqayıt ve Bakü\'de — yurt dışı eğitim başvurusu, belgeler ve danışmanlık.',
        return_title: 'Başvurunuza dönün',
        return_sub: 'Başvururken yazdığınız e-posta adresini girin — giriş bağlantısını oraya göndereceğiz. Şifre hatırlamanıza gerek yok.',
        return_send: 'Giriş bağlantısı gönder',
        return_sending: 'Gönderiliyor...',
        return_sent: 'Bağlantı gönderildi. Posta kutunuzu kontrol edin — tıkladığınızda doğrudan başvurunuza dönersiniz.',
        return_bad_email: 'Geçerli bir e-posta adresi yazın.',
        return_back: '← Geri dön',
        return_welcome: 'Hoş geldiniz!',
        apply_submit: 'Başvuruyu gönder',
        apply_sending: 'Gönderiliyor...',
        apply_saved: 'Başvurunuz alındı!',
        apply_check_mail_title: 'E-postanızı kontrol edin',
        apply_check_mail_sub: 'Başvurunuzu tamamlamak için postanıza gönderdiğimiz bağlantıya tıklayın. Yazdıklarınız kaybolmadı — kaldığınız yerden devam edeceksiniz.',
        apply_check_mail_toast: 'Postanıza onay bağlantısı gönderdik.',
        admin_src_all: 'Tümü',
        admin_src_kurs: 'Kurs',
        admin_src_abroad: 'Yurt dışı eğitim',
        student_badge_abroad: 'Yurt dışı',
        years_with_you: '20 yıldır sizinle',
        splash_tag: 'Yurt dışı eğitim rotanız — üniversite seçiminden vize belgelerine kadar tek bir yerde.',
        splash_start: 'Başla',
        start_connection_error: 'Sunucuya bağlanılamadı. İnternet bağlantınızı kontrol edip tekrar deneyin.',
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
        trialexams_review_btn: 'İncele →',
        trialexams_review_title: 'Göndermeden önce gözden geçirin',
        trialexams_review_back: 'Sorulara dön',
        trialexams_review_summary_tpl: '{answered}/{total} soru cevaplandı',
        trialexams_exit_confirm: 'Sınavdan çıkmak istediğinizden emin misiniz? Cevaplarınız kaydedilmeyecek.',
        trialexams_time_expired_title: 'Süre doldu',
        trialexams_time_expired_sub: 'Bu sınav için ayrılan süre dolduğu için deneminiz otomatik olarak kapatıldı. Sonucunuzu "Deneme sınavları" bölümünde görebilirsiniz.',
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

    /* ── Xaricdə təhsil saytına aid mətn fərqləri ──────────────
       Açarlar dörd dil blokundakı ilə eynidir; burada yalnız həmin
       saytda fərqli oxunan dəyərlər saxlanılır. */
    const ABROAD_I18N = {
      page_title: {
        az: 'Bilik — Xaricdə Təhsil',
        en: 'Bilik — Study Abroad',
        ru: 'Bilik — Учёба за рубежом',
        tr: 'Bilik — Yurt Dışında Eğitim'
      },
      splash_tag: {
        az: 'Xaricdə təhsil müraciətin — universitet seçimindən sənədlərin təhvilinə qədər onlayn.',
        en: 'Your study-abroad application — from choosing a university to submitting documents, all online.',
        ru: 'Ваша заявка на учёбу за рубежом — от выбора университета до подачи документов, онлайн.',
        tr: 'Yurt dışı eğitim başvurun — üniversite seçiminden belge tesliminе kadar çevrimiçi.'
      },
      home_card_achieve_title: { az: 'Qəbullar', en: 'Admissions', ru: 'Поступления', tr: 'Kabuller' },
      home_card_achieve_sub: { az: 'Qəbullarımız', en: 'Our admissions', ru: 'Наши поступления', tr: 'Kabullerimiz' },
      achievements_title: { az: 'Qəbullarımız', en: 'Our admissions', ru: 'Наши поступления', tr: 'Kabullerimiz' },
      achievements_empty: {
        az: 'Hələ heç bir qəbul əlavə olunmayıb.',
        en: 'No admissions have been added yet.',
        ru: 'Поступления ещё не добавлены.',
        tr: 'Henüz kabul eklenmedi.'
      }
    };

    function abroadOverridesFor(lang) {
      const out = {};
      Object.keys(ABROAD_I18N).forEach(key => {
        const val = ABROAD_I18N[key][lang];
        if (val) out[key] = val;
      });
      return out;
    }

    function applyLanguage(lang) {
      if (!lang) return;
      currentLang = lang;

      try {
        window.localStorage.setItem('btm_lang', lang);
      } catch (e) {
        console.warn('localStorage write error:', e);
      }

      const base = translations[lang];
      if (!base) return;

      /* Xaricdə təhsil saytında bir neçə başlıq fərqli oxunur ("Nailiyyətlər"
         əvəzinə "Qəbullarımız" və s.). Bu fərqləri dörd dil blokunun içinə
         yaymaq əvəzinə burada üst-üstə qoyuruq — beləcə blokların açar
         paritetini pozmuruq və fərqlər bir yerdə görünür. */
      const t = Object.assign({}, base, abroadOverridesFor(lang));

      // Ekran oxuyucuları və brauzerin tərcümə/hecalama qaydaları üçün
      // sənədin dili də dəyişməlidir.
      document.documentElement.setAttribute('lang', lang);

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

    /* Yadda saxlanılmış dili tətbiq et.
       'az' üçün normalda çağırmağa ehtiyac yoxdur — HTML-dəki sabit mətnlər
       onsuz da Azərbaycancadır. Xaricdə təhsil saytında isə mütləq çağırılmalıdır:
       "Nailiyyətlər" → "Qəbullar" kimi fərqlər yalnız applyLanguage-də tətbiq olunur. */
    if (currentLang) {
      applyLanguage(currentLang);
    }

    /* ═══════════════════════════════════════════════════════════
       PWA — Service Worker qeydiyyatı (offline dəstək)
    ═══════════════════════════════════════════════════════════ */
    if ('serviceWorker' in navigator && window.location.protocol !== 'file:') {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW qeydiyyatı alınmadı:', err));
      });
    }

