  let currentHistoryMode = 'daily'; 
  let historyFilters = { daily: { month: null, driver: "" }, driver: { month: null, driver: "" } }; 

  // ===== Service Worker (PWA) =====
  if ('serviceWorker' in navigator && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js').catch(function (err) {
        console.warn('Service Worker registration failed:', err);
      });
    });
  } else if ('serviceWorker' in navigator && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
    // บน localhost ทำการ unregister เพื่อให้โหลดโค้ดและ CSS ล่าสุดเสมอ
    navigator.serviceWorker.getRegistrations().then(function(regs) {
      for (let r of regs) r.unregister();
    }).catch(function() {});
  }

  const WEB_APP_URL = "https://script.google.com/macros/s/AKfycbwUpWVLQQ15Cpikdi-MgWiMb1RWRFv79lIXobeufSX4PosQpJpcEJcdI5ZPOziEEM1bFg/exec"; 

  const SYNC_QUEUE_KEY = 'egat_sync_queue';
  const SYNC_MAX_RETRY = 5;

  const CloudStorage = {
      syncQueue: [],
      isSyncing: false,
      isReady: false,
      cloudReachable: true,

      // คืนคิวที่ค้างไว้จาก localStorage (กรณีผู้ใช้รีเฟรชขณะออฟไลน์)
      loadQueue: function() {
          try {
              const raw = localStorage.getItem(SYNC_QUEUE_KEY);
              const parsed = raw ? JSON.parse(raw) : [];
              this.syncQueue = Array.isArray(parsed) ? parsed : [];
          } catch(e) { this.syncQueue = []; }
      },
      saveQueue: function() {
          try { localStorage.setItem(SYNC_QUEUE_KEY, JSON.stringify(this.syncQueue)); } catch(e) {}
      },
      enqueue: function(key, value) {
          // รวมรายการซ้ำของ key เดียวกัน ให้เหลือเฉพาะค่าล่าสุด ลดขนาดคิวและกันข้อมูลเก่าทับของใหม่
          const idx = this.syncQueue.findIndex(t => t.key === key);
          const task = { key: key, value: value, tries: 0 };
          if (idx !== -1) this.syncQueue[idx] = task;
          else this.syncQueue.push(task);
          this.saveQueue();
      },

      setItem: function(key, value, forceQueue = false) {
          // [HOTFIX] บีบอัดข้อมูลก่อนเซฟ: ลบ HTML ขยะที่กินพื้นที่มหาศาลทิ้ง
          // ป้องกันปัญหา Payload ใหญ่เกินจนชนโควต้า Cloud แล้วข้อมูลหาย
          if (key === 'egat_ot_history') {
              try {
                  if (typeof otHistory !== 'undefined' && Array.isArray(otHistory)) {
                      otHistory.forEach(item => {
                          delete item.html;
                          delete item.maxOTMinutes;
                          delete item.dispTotalMinutes;
                      });
                      value = JSON.stringify(otHistory);
                  }
              } catch(e) {}
          }

          try { localStorage.setItem(key, value); }
          catch(e) {
              console.warn('LocalStorage เต็ม หรือถูกปิดใช้งาน:', e);
              alert('⚠️ พื้นที่จัดเก็บข้อมูลในเครื่องเต็มแล้ว\nกรุณาสำรองข้อมูล (ดาวน์โหลดไฟล์ .json) และลบรายการเก่าที่ไม่จำเป็น');
              return;
          }
          if (key === 'egat_ot_draft' || key === 'egat_sidebar_collapsed') return;

          // บันทึกเวลาแก้ไขล่าสุดไว้ เพื่อป้องกันข้อมูลที่บันทึกระหว่างรอคลาวด์ถูกทับ
          if (key === 'egat_ot_history' || key === 'egat_drivers' || key === 'egat_ot_verified_status') {
              try { localStorage.setItem('egat_local_dirty', String(Date.now())); } catch(e) {}
          }

          if (this.isReady || forceQueue) {
              this.enqueue(key, value);
              this.processQueue();
          }
      },
      getItem: function(key) {
          try { return localStorage.getItem(key); } catch(e) { return null; }
      },
      showSyncToast: function(msg, isError) {
          try {
              let t = document.getElementById('syncToast');
              if (!t) {
                  t = document.createElement('div');
                  t.id = 'syncToast';
                  t.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:24px;z-index:9999;' +
                      'padding:12px 20px;border-radius:50px;font-family:inherit;font-weight:700;font-size:0.95rem;' +
                      'box-shadow:0 8px 24px rgba(0,0,0,0.18);transition:opacity .3s;max-width:90vw;text-align:center;';
                  document.body.appendChild(t);
              }
              t.textContent = msg;
              t.style.background = isError ? '#fef2f2' : '#10b981';
              t.style.color = isError ? '#b91c1c' : '#fff';
              t.style.opacity = '1';
              clearTimeout(this._toastTimer);
              this._toastTimer = setTimeout(() => { t.style.opacity = '0'; }, 3200);
          } catch(e) {}
      },
      processQueue: async function() {
          if (this.isSyncing || this.syncQueue.length === 0) return;
          if (!navigator.onLine) return;
          this.isSyncing = true;

          try {
              while (this.syncQueue.length > 0) {
                  const task = this.syncQueue[0];
                  try {
                      // [FIX] เพิ่ม timeout — Apps Script ค้างค้างได้ ไม่งั้นคิวจะถูกล็อกทั้งแอป
                      const controller = new AbortController();
                      const timeoutId = setTimeout(() => controller.abort(), 15000);

                      let res;
                      try {
                          res = await fetch(WEB_APP_URL, {
                              method: 'POST',
                              body: JSON.stringify({ key: task.key, value: task.value }),
                              headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                              signal: controller.signal
                          });
                      } finally {
                          clearTimeout(timeoutId);
                      }

                      // [FIX] ต้องตรวจสอบสถานะจริง เดิมไม่เช็ค ทำให้ error ถูกนับว่าสำเร็จแล้วข้อมูลหายถาวร
                      if (!res.ok) throw new Error('HTTP ' + res.status);

                      // [FIX] Apps Script ตอบ 200 แม้สคริปต์พัง (คืน HTML error page)
                      // ต้องอ่าน body ตรวจด้วย ไม่งั้นข้อมูลถูกทิ้งทั้งที่ยังไม่ได้บันทึกขึ้นคลาวด์
                      let body = '';
                      try { body = await res.text(); } catch(e) {}
                      if (/^\s*</.test(body) || /script error|exception occurred/i.test(body)) {
                          throw new Error('Apps Script ตอบกลับผิดรูปแบบ');
                      }

                      this.syncQueue.shift();
                      this.cloudReachable = true;
                      // [FIX] รีเซ็ตตัวนับเมื่อสำเร็จ กันงานที่เคยพลาดถูกทิ้งถาวรเพราะพลาดสะสมข้าม session
                      this.saveQueue();

                      // [SYNC FIX] เมื่อส่งคิวครบทั้งหมดแล้ว ให้ล้างสถานะ dirty ในเครื่อง เพื่อให้เปิดรับข้อมูลใหม่จากคลาวด์ได้เสมอ
                      if (this.syncQueue.length === 0) {
                          try { localStorage.removeItem('egat_local_dirty'); } catch(e) {}
                          try { localStorage.setItem('egat_cloud_synced_at', String(Date.now())); } catch(e) {}
                      }
                  } catch (e) {
                      task.tries = (task.tries || 0) + 1;
                      console.warn('Cloud Sync ล้มเหลว (จะลองใหม่อัตโนมัติ):', e);
                      this.cloudReachable = false;

                      // [FIX] เดิมทิ้งรายการถาวรเมื่อครบ 5 ครั้ง (นับสะสมข้ามการรีเฟรช)
                      // ทำให้ข้อมูลหายจากคิวโดยไม่มีทางกู้ — เปลี่ยนเป็น "หยุดลองซ้ำชั่วคราว" แทน
                      if (task.tries >= SYNC_MAX_RETRY) {
                          task.tries = 0;           // รีเซ็ต ไม่ใช่ทิ้ง
                          task.deferredUntil = Date.now() + 60000;
                          this.saveQueue();
                          this.showSyncToast('⚠️ ซิงค์คลาวด์ไม่สำเร็จ — ข้อมูลยังอยู่ในเครื่อง จะลองใหม่อัตโนมัติ', true);
                          // [FIX] แจ้งผู้ใช้ให้กู้คืนได้ด้วย ไม่ใช่เก็บเงียบ ๆ
                          try {
                              const failed = JSON.parse(localStorage.getItem('egat_sync_failed') || '[]');
                              failed.push({ key: task.key, value: task.value, time: new Date().toISOString(), note: 'เลื่อนการส่งซ้ำอัตโนมัติ' });
                              localStorage.setItem('egat_sync_failed', JSON.stringify(failed.slice(-50)));
                          } catch(err) {}
                          break;
                      }
                      this.saveQueue();
                      break;
                  }
              }
          } finally {
              // [FIX] เดิมถ้าโค้ดใน while พัง (ไม่ใช่ที่ catch) isSyncing จะค้างเป็น true
              // ทำให้ซิงค์ได้ครั้งเดียวตลอดชีวิตของหน้าเว็บ
              this.isSyncing = false;
          }

          this.saveQueue();
          this.scheduleRetry();
      },

      // [FIX] เดิมไม่มีตัวจัดตารางซ้ำ ถ้าคิวค้างจากความล้มเหลวครั้งเดียว
      // ข้อมูลจะไม่ถูกส่งอีกเลยจนกว่าผู้ใช้จะบันทึกอะไรใหม่
      scheduleRetry: function() {
          clearTimeout(this._retryTimer);
          const next = this.syncQueue.find(t => !t.deferredUntil || t.deferredUntil <= Date.now());
          if (!next || !navigator.onLine) return;

          const wait = Math.max(500, next.deferredUntil ? next.deferredUntil - Date.now() : 0);
          this._retryTimer = setTimeout(() => this.processQueue(), wait);
      },

      // [FIX] ข้อมูลที่ส่งไม่สำเร็จต้องกู้คืนได้จริง ไม่ใช่แค่ถูกบันทึกไว้เฉย ๆ
      restoreFailedSyncs: function() {
          try {
              const failed = JSON.parse(localStorage.getItem('egat_sync_failed') || '[]');
              if (!Array.isArray(failed) || failed.length === 0) return 0;
              failed.forEach(item => this.enqueue(item.key, item.value));
              localStorage.setItem('egat_sync_failed', '[]');
              this.processQueue();
              return failed.length;
          } catch(e) { return 0; }
      }
  };

  async function initCloudData(isManual = false) {
      const emptyMsg = document.getElementById('emptyMsg');
      const emptyMsgLoading = document.getElementById('emptyMsgLoading');
      const emptyMsgNoData = document.getElementById('emptyMsgNoData');

      // [FIX] เดิมไม่มีตัวฟัง event online/offline เลย
      // เมื่อผู้ใช้ออฟไลน์บันทึกข้อมูล แล้วกลับมาออนไลน์ คิวจะไม่เคยถูกส่ง
      // เพราะ processQueue ถูกเรียกเฉพาะตอน init และตอน setItem เท่านั้น
      window.addEventListener('online', () => {
          CloudStorage.cloudReachable = true;
          CloudStorage.syncQueue.forEach(t => { delete t.deferredUntil; });
          CloudStorage.showSyncToast('🌐 กลับมาออนไลน์ — กำลังซิงค์ข้อมูลที่ค้าง');
          CloudStorage.processQueue();
      });
      window.addEventListener('offline', () => {
          CloudStorage.cloudReachable = false;
          CloudStorage.showSyncToast('📴 ออฟไลน์ — ข้อมูลจะบันทึกไว้ในเครื่องและซิงค์ภายหลัง', true);
      });

      // [FIX] ปิดหน้า/สลับแท็บขณะ fetch ค้างอยู่ ข้อมูลที่ยังไม่ได้เขียนลง localStorage
      // จะหายไป — บังคับ flush ให้เรียบร้อยก่อน
      const flushNow = () => {
          try {
              CloudStorage.saveQueue();
              if (document.getElementById('driverSelect')) saveFormDraft();
          } catch(e) {}
      };
      window.addEventListener('pagehide', flushNow);
      document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'hidden') {
              flushNow();
          } else if (document.visibilityState === 'visible' && navigator.onLine) {
              // [AUTO-SYNC] สลับกลับมาที่แท็บ ให้ดึงข้อมูลล่าสุดจากคลาวด์อัตโนมัติ
              initCloudData(false);
          }
      });
      window.addEventListener('focus', () => {
          if (navigator.onLine) initCloudData(false);
      });
      // [AUTO-SYNC] ตรวจสอบและดึงข้อมูลอัปเดตจากคลาวด์ทุก 60 วินาทีเมื่อแท็บเปิดอยู่
      if (!window._egatSyncInterval) {
          window._egatSyncInterval = setInterval(() => {
              if (navigator.onLine && CloudStorage.cloudReachable && document.visibilityState === 'visible') {
                  initCloudData(false);
              }
          }, 60000);
      }

      // กู้คิวที่ค้างจาก session ก่อนหน้า (เช่น ผู้ใช้รีเฟรชตอนออฟไลน์)
      CloudStorage.loadQueue();

      if(emptyMsg && emptyMsgLoading && emptyMsgNoData) {
          emptyMsgLoading.style.display = 'block';
          emptyMsgNoData.style.display = 'none';
          emptyMsg.style.display = 'block';
      }

      // ตรวจสอบงานที่ค้างส่งในคิว
      const hasPendingUpload = (k) => Array.isArray(CloudStorage.syncQueue) && CloudStorage.syncQueue.some(t => t.key === k);

      // [FIX] ตั้ง timeout ป้องกันค้างเมื่อเน็ตล่ม/ไฟร์วอลล์บล็อก
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 12000);

      try {
          const res = await fetch(WEB_APP_URL, { signal: controller.signal });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const cloudData = await res.json();

          if (!cloudData || typeof cloudData !== 'object') {
              throw new Error('รูปแบบข้อมูลจากคลาวด์ไม่ถูกต้อง');
          }
          
          try { CloudStorage.setItem('egat_cloud_synced_at', String(Date.now())); } catch(e) {}

          const safeParse = (raw, fallback) => {
              if (raw === undefined || raw === null || raw === '') return fallback;
              try {
                  const parsed = JSON.parse(raw);
                  return parsed === null || parsed === undefined ? fallback : parsed;
              } catch(e) {
                  console.warn('ข้อมูลจากคลาวด์อ่านไม่ได้ (ข้ามคีย์นี้):', e);
                  return fallback;
              }
          };

          // ซิงค์รายชื่อ พขร. จากคลาวด์ (ถ้าไม่มีงานค้างส่งคีย์นี้)
          if (cloudData['egat_drivers'] && !hasPendingUpload('egat_drivers')) {
              let fetchedDrivers = safeParse(cloudData['egat_drivers'], null);
              if (fetchedDrivers && fetchedDrivers.length > 0 && typeof fetchedDrivers[0] === 'string') {
                  drivers = fetchedDrivers.map(d => ({ id: Date.now() + Math.random(), name: d, nickname: '', phone: '', affiliation: '', department: '' }));
                  CloudStorage.setItem('egat_drivers', JSON.stringify(drivers), true);
              } else if (Array.isArray(fetchedDrivers)) {
                  drivers = fetchedDrivers;
                  try { localStorage.setItem('egat_drivers', cloudData['egat_drivers']); } catch(e){}
              }
          }

          // ซิงค์ประวัติ OT จากคลาวด์ (ถ้าไม่มีงานค้างส่งคีย์นี้)
          if (cloudData['egat_ot_history'] && !hasPendingUpload('egat_ot_history')) {
              const fetchedHistory = safeParse(cloudData['egat_ot_history'], null);
              if (Array.isArray(fetchedHistory)) {
                  otHistory = fetchedHistory;
                  try { sanitizeHistoryData(); } catch(e) {}
                  try { localStorage.setItem('egat_ot_history', JSON.stringify(otHistory)); } catch(e){}
              }
          }

          // ซิงค์สถานะการตรวจสอบ 3 ระดับ จากคลาวด์ (ถ้าไม่มีงานค้างส่งคีย์นี้)
          if (cloudData['egat_ot_verified_status'] && !hasPendingUpload('egat_ot_verified_status')) {
              const fetchedVerified = safeParse(cloudData['egat_ot_verified_status'], null);
              if (fetchedVerified && typeof fetchedVerified === 'object' && !Array.isArray(fetchedVerified)) {
                  verifiedStatus = fetchedVerified;
                  try { localStorage.setItem('egat_ot_verified_status', cloudData['egat_ot_verified_status']); } catch(e){}
              }
          }

          // ถ้าไม่มีคิวค้างส่งเลย ให้ล้างสถานะ dirty ในเครื่องทันที
          if (CloudStorage.syncQueue.length === 0) {
              try { localStorage.removeItem('egat_local_dirty'); } catch(e) {}
          }

          // กู้รายการที่เคยส่งไม่สำเร็จกลับเข้าคิวอัตโนมัติ
          try {
              const restored = CloudStorage.restoreFailedSyncs();
              if (restored > 0) {
                  console.info(`กู้คืนรายการที่เคยซิงค์ไม่สำเร็จ ${restored} รายการ`);
              }
          } catch(e) {}

          CloudStorage.isReady = true;
          CloudStorage.cloudReachable = true;
          CloudStorage.processQueue();

          if(emptyMsgLoading && emptyMsgNoData) {
              emptyMsgLoading.style.display = 'none';
              emptyMsgNoData.style.display = 'block';
          }

          renderDrivers();
          sortHistory();
          renderHistory();
          try { if (typeof renderAdminDashboard === 'function') renderAdminDashboard(); } catch(e) {}
          updateBadge();

          if (isManual) {
              CloudStorage.showSyncToast('✅ ซิงค์ข้อมูลล่าสุดจากคลาวด์เรียบร้อยแล้ว');
          }
      } catch (error) {
          console.warn('โหลดข้อมูลคลาวด์ไม่สำเร็จ (ใช้ข้อมูลในเครื่องแทน):', error);
          CloudStorage.cloudReachable = false;

          CloudStorage.isReady = true;
          CloudStorage.processQueue();

          if(emptyMsgLoading && emptyMsgNoData) {
              emptyMsgLoading.style.display = 'none';
              emptyMsgNoData.style.display = 'block';
          }
          if (!navigator.onLine) {
              CloudStorage.showSyncToast('📴 ออฟไลน์ — ใช้ข้อมูลจากเครื่อง', true);
          } else if (isManual) {
              CloudStorage.showSyncToast('⚠️ เชื่อมต่อคลาวด์ไม่สำเร็จ — ใช้ข้อมูลในเครื่องแทน', true);
          }
      } finally {
          clearTimeout(timeoutId);
      }
  }
  window.syncCloudData = initCloudData;
    
  let pickerTargetId = null;
  let pickerDisplayId = null;
  let pickerCurrentDate = new Date();
  const THAI_MONTHS_SHORT = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

  function saveFormDraft() {
      const typeEl = document.querySelector('input[name="type"]:checked');
      const draft = {
          driver: document.getElementById('driverSelect')?.value || "",
          date: document.getElementById('workDate')?.value || "",
          type: typeEl ? typeEl.value : 'weekday',
          start: document.getElementById('startTime')?.value || "08:00",
          end: document.getElementById('endTime')?.value || "17:00"
      };
      CloudStorage.setItem('egat_ot_draft', JSON.stringify(draft));
  }

  function updateRadioStyle() {
    document.querySelectorAll('.radio-line label').forEach(lbl => {
        const rad = lbl.querySelector('input[type="radio"]');
        if(rad && rad.checked) lbl.classList.add('active');
        else lbl.classList.remove('active');
    });
  }

  // ---------- Sidebar ยุบ/ขยาย ----------
// [FIX] เดิมใช้ตัวแปร `sidebar` ที่ไม่เคยถูกประกาศค่าไว้เลย
// ทำให้กดแล้วเกิด ReferenceError และไม่มีอะไรเกิดขึ้น
function toggleSidebar(forceState) {
      const sidebarEl = document.getElementById('sidebar');
      if (!sidebarEl) return false;

      const willCollapse = (typeof forceState === 'boolean')
          ? forceState
          : !sidebarEl.classList.contains('collapsed');

      sidebarEl.classList.toggle('collapsed', willCollapse);

      // เปลี่ยนไอคอนปุ่มเป็น "ขยายกลับ" เมื่อยุบอยู่
      const btn = document.getElementById('btnToggle');
      if (btn) {
          btn.textContent = willCollapse ? '»' : '≡';
          btn.title = willCollapse ? 'ขยายแถบเมนู' : 'ยุบแถบเมนู';
          btn.setAttribute('aria-expanded', willCollapse ? 'false' : 'true');
      }

      try { CloudStorage.setItem('egat_sidebar_collapsed', willCollapse ? '1' : '0'); } catch(e) {}
      return willCollapse;
  }
  window.toggleSidebar = toggleSidebar;

  // คืนค่าสถานะเดิมหลังรีเฟรช
  function restoreSidebarState() {
      let saved = '0';
      try { saved = CloudStorage.getItem('egat_sidebar_collapsed') || '0'; } catch(e) {}
      // บังคับให้แถบเมนูยุบล่วงหน้าเสมอ เพื่อให้ตัวชี้วัดได้ (สำคัญตอนออกแบบหน้าจอ)
      toggleSidebar(saved === '1');
  }
  window.restoreSidebarState = restoreSidebarState;

  function toggleSidebarSubmenu(id) {
      const submenu = document.getElementById(id);
      const parent = submenu.parentElement.querySelector('.menu-item');
      if (submenu) {
          if (submenu.classList.contains('open')) {
              submenu.classList.remove('open');
              parent.classList.remove('expanded');
          } else {
              submenu.classList.add('open');
              parent.classList.add('expanded');
          }
      }
  }

  function openBackupModal() {
      // [AUTH] เมนูสำรอง/นำเข้าข้อมูล ใช้ได้เฉพาะผู้ดูแลระบบ
      if (typeof Auth !== 'undefined' && !Auth.isAdmin()) {
          alert('⛔ เมนูนี้ใช้ได้เฉพาะผู้ดูแลระบบเท่านั้น\nกรุณาเข้าสู่ระบบด้วย PIN แอดมินครับ');
          return;
      }
      document.getElementById('backupModal').classList.add('show');
  }
  function closeBackupModal() {
      document.getElementById('backupModal').classList.remove('show');
      const fileInp = document.getElementById('importFile');
      if(fileInp) fileInp.value = "";
      
      const expType = document.getElementById('exportType');
      if(expType) {
          expType.value = 'all';
          toggleExportMonthFilter();
      }
      const expMonth = document.getElementById('exportMonthInput');
      if(expMonth) expMonth.value = '';
  }

  function toggleExportMonthFilter() {
      const type = document.getElementById('exportType').value;
      const filterDiv = document.getElementById('exportHistoryFilter');
      if (type === 'history') {
          filterDiv.style.display = 'block';
      } else {
          filterDiv.style.display = 'none';
      }
  }

  function exportData() {
      const type = document.getElementById('exportType').value;
      let data = {};
      let filenameSuffix = "";

      const allDrivers = JSON.parse(CloudStorage.getItem('egat_drivers')) || [];
      let allHistory = JSON.parse(CloudStorage.getItem('egat_ot_history')) || [];
      const allVerified = JSON.parse(CloudStorage.getItem('egat_ot_verified_status')) || {};

      if (type === 'all') {
          data = { drivers: allDrivers, history: allHistory, verified: allVerified };
          filenameSuffix = "all";
      } else if (type === 'drivers') {
          data = { drivers: allDrivers };
          filenameSuffix = "drivers";
      } else if (type === 'history') {
          const exportMonth = document.getElementById('exportMonthInput').value;
          if (exportMonth) {
              const [year, month] = exportMonth.split('-');
              allHistory = allHistory.filter(item => {
                  if (!item.date) return false;
                  const itemDateStr = item.date;
                  return itemDateStr.startsWith(`${year}-${month}`);
              });
              filenameSuffix = `history_${exportMonth}`;
          } else {
              filenameSuffix = "history_all";
          }
          data = { history: allHistory };
      } else if (type === 'verified') {
          data = { verified: allVerified };
          filenameSuffix = "verified";
      }

      const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(data));
      const downloadAnchorNode = document.createElement('a');
      downloadAnchorNode.setAttribute("href", dataStr);
      const dateStr = new Date().toISOString().slice(0,10);
      downloadAnchorNode.setAttribute("download", `egat_ot_backup_${filenameSuffix}_${dateStr}.json`);
      document.body.appendChild(downloadAnchorNode);
      downloadAnchorNode.click();
      downloadAnchorNode.remove();
      closeBackupModal();
  }
  function importData(event) {
      const file = event.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function(e) {
          try {
              const data = JSON.parse(e.target.result);
              let importedParts = [];
              if (data.drivers && Array.isArray(data.drivers)) {
                  CloudStorage.setItem('egat_drivers', JSON.stringify(data.drivers));
                  importedParts.push("รายชื่อ พขร.");
              }
              if (data.history && Array.isArray(data.history)) {
                  CloudStorage.setItem('egat_ot_history', JSON.stringify(data.history));
                  importedParts.push("ประวัติการทำ OT");
              }
              if (data.verified && typeof data.verified === 'object') {
                  CloudStorage.setItem('egat_ot_verified_status', JSON.stringify(data.verified));
                  importedParts.push("สถานะการตรวจสอบ");
              }
              
              if (importedParts.length > 0) {
                  alert(`✅ นำเข้าข้อมูลเรียบร้อยแล้ว\n(ข้อมูลที่นำเข้า: ${importedParts.join(', ')})\n\nระบบจะทำการรีเฟรชหน้าจอเพื่อแสดงผลใหม่`);
                  location.reload();
              } else {
                  alert('❌ ไม่พบข้อมูลที่เข้ากันได้ในไฟล์นี้');
              }
          } catch(err) {
              alert('❌ ไฟล์ไม่ถูกต้อง หรือเกิดข้อผิดพลาดในการนำเข้า');
          }
      };
      reader.readAsText(file);
  }

  // [FIX] หนีอาการ Header/ข้อมูลซ้อนทับกันในไฟล์ CSV
  // เดิมอ่านค่าจาก DOM ด้วย col.innerText ซึ่งรวมปุ่ม/ไอคอน/ช่องว่างเข้ามาด้วย
  // และตัดไอคอนด้วย regex ที่ไม่ครอบคลุม -> คอลัมน์เลื่อนผิดตำแหน่ง
  // วิธีแก้: สร้าง CSV จาก "ข้อมูลดิบ" โดยตรง ไม่ scrape DOM
  const CSV_HEADERS = ['ลำดับ', 'ชื่อ พขร.', 'OT X1.5', 'OT X1', 'OT X3', 'รวมเวลาทำ (ชม.)', 'ขอเบิก OT (ชม.)', 'ลา (วัน)', 'สถานะ'];

  // escape ตาม RFC 4180: ครอบด้วย " เสมอ และเพิ่ม " เป็น ""
  const csvCell = (value) => {
      let v = (value === null || value === undefined) ? '' : String(value);
      v = v.replace(/[\r\n]+/g, ' ').trim();
      return '"' + v.replace(/"/g, '""') + '"';
  };

  // นาที -> ชั่วโมง 1 ทศนิยม; ค่าว่าง/ศูนย์ -> "0" (ให้ Excel SUM ได้)
  const toHoursStr = (mins, fixed1) => {
      const useFixed = fixed1 === undefined ? true : fixed1;
      const num = Number(mins);
      if (!isFinite(num)) return useFixed ? '0.0' : '0';
      const hours = Math.round((num / 60) * 10) / 10;
      if (!isFinite(hours)) return useFixed ? '0.0' : '0';
      return useFixed ? hours.toFixed(1) : hours.toString().replace(/\.0$/, '');
  };

  // [FIX] "ขอเบิก OT" เก็บเป็น "ชั่วโมง" อยู่แล้ว (ไม่ใช่นาที) จึงห้ามหารด้วย 60 ซ้ำ
  const toHoursPlain = (hours) => {
      const num = Number(hours);
      if (!isFinite(num)) return '0';
      const v = Math.round(num * 10) / 10;
      if (!isFinite(v)) return '0';
      return v.toString().replace(/\.0$/, '');
  };

  window.__csvHeaders = CSV_HEADERS;
  window.__csvCell = csvCell;
  window.__toHoursStr = toHoursStr;

  // รวบรวมข้อมูลสรุปรายเดือน (โหมด สรุป พขร.) — ใช้ร่วมกันระหว่างหน้าจอกับ CSV
  function collectDriverSummary() {
      const monthPicker = document.getElementById('historyMonthPicker');
      let rawVal = monthPicker ? monthPicker.value : '';
      if (!rawVal || !/^\d{4}-\d{2}$/.test(rawVal)) {
          rawVal = (typeof getGlobalSelectedMonth === 'function') ? getGlobalSelectedMonth() : '';
      }
      let targetYear = new Date().getFullYear();
      let targetMonth = new Date().getMonth();
      if (rawVal && /^\d{4}-\d{2}$/.test(rawVal)) {
          const parts = rawVal.split('-').map(Number);
          targetYear = parts[0];
          targetMonth = parts[1] - 1;
      }

      const summaryMap = {};
      otHistory.forEach(item => {
          if (!item || !item.date) return;
          const d = new Date(item.date);
          if (isNaN(d.getTime())) return;
          if (d.getMonth() !== targetMonth || d.getFullYear() !== targetYear) return;

          const name = getPlainName(item.driver) || '(ไม่ระบุชื่อ)';
          if (!summaryMap[name]) {
              summaryMap[name] = { ot15:0, ot1:0, ot3:0, leave:0, missingCount:0, requestOT:0, isGhost:false };
          }
          if (item.isLeave) {
              summaryMap[name].leave++;
          } else if (!item.isPending) {
              summaryMap[name].ot15 += (Number(item.ot15) || 0);
              summaryMap[name].ot1  += (Number(item.ot1)  || 0);
              summaryMap[name].ot3  += (Number(item.ot3)  || 0);
              summaryMap[name].requestOT += (parseFloat(item.requestOT) || 0);
          }
          // [FIX] นับเฉพาะเอกสารตกค้างจริง — วันลา (isLeave) ไม่นับเป็น "ขาด"
          if (item.isIncomplete && !item.isLeave) summaryMap[name].missingCount++;
      });

      let names = Object.keys(summaryMap);
      names.sort((a, b) => {
          const ia = drivers.findIndex(d => d.name === a);
          const ib = drivers.findIndex(d => d.name === b);
          if (ia === -1 && ib === -1) return a.localeCompare(b, 'th');
          if (ia === -1) return 1;
          if (ib === -1) return -1;
          return ia - ib;
      });

      const monthKey = `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}`;
      const rows = names.map(name => {
          const d = summaryMap[name];
          // [SYNC FIX] ใช้สถานะ 3 ระดับจาก Single Source เดียวกัน (กัน export ไม่ตรงหน้าจอ)
          const st = getVerifyState(name, monthKey);
          const meta = (typeof ST_LABEL !== 'undefined' && ST_LABEL[st]) ? ST_LABEL[st] : { text: 'รอตรวจสอบ' };
          let status = meta.text;
          if (d.missingCount > 0) status += ` / ขาดเอกสาร ${d.missingCount}`;
          return {
              name: name,
              isGhost: d.isGhost,
              ot15: toHoursStr(d.ot15),
              ot1:  toHoursStr(d.ot1),
              ot3:  toHoursStr(d.ot3),
              total: toHoursStr(d.ot15 + d.ot1 + d.ot3),
              requestOT: toHoursPlain(d.requestOT),
              leave: String(d.leave || 0),
              status: status
          };
      });

      return { targetYear: targetYear, targetMonth: targetMonth, rows: rows };
  }

  window.__collectDriverSummary = collectDriverSummary;

  // [FIX] ส่งออก CSV จากข้อมูลดิบ — ไม่ scrape DOM (เดิม Header/ข้อมูลซ้อนทับกัน)
  window.exportSummaryToCSV = function() {
      if (currentHistoryMode !== 'driver') {
          alert('⚠️ ฟังก์ชันนี้ใช้ได้เฉพาะในโหมด "2. สรุป พขร. (ยอดรวม)" เท่านั้นครับ\nกรุณาเปลี่ยนโหมดก่อนทำการส่งออกครับ');
          return;
      }

      const summary = collectDriverSummary();

      if (!summary.rows.length) {
          alert('⚠️ ไม่มีข้อมูลในเดือนที่เลือก กรุณาเลือกเดือนที่มีข้อมูลก่อนส่งออกครับ');
          return;
      }

      // BOM นำหน้าไฟล์ เพื่อให้ Excel อ่านภาษาไทยได้ถูกต้อง
      let csv = '\uFEFF';
      csv += CSV_HEADERS.map(csvCell).join(',') + '\r\n';

      summary.rows.forEach((r, idx) => {
          const cells = [
              (idx + 1).toString(),
              r.isGhost ? r.name + ' (เกินระบบ)' : r.name,
              r.ot15, r.ot1, r.ot3, r.total,
              r.requestOT, r.leave, r.status
          ];
          csv += cells.map(csvCell).join(',') + '\r\n';
      });

      // แถวรวมยอด ช่วยให้ตรวจสอบยอดรวมได้เร็วใน Excel
      const sumCol = (key) => {
          const t = summary.rows.reduce((acc, r) => acc + (parseFloat(r[key]) || 0), 0);
          return (Math.round(t * 10) / 10).toFixed(1);
      };
      const totalLeave = summary.rows.reduce((a, r) => a + (parseInt(r.leave, 10) || 0), 0);
      csv += ['', 'รวมทั้งหมด', sumCol('ot15'), sumCol('ot1'), sumCol('ot3'), sumCol('total'),
              sumCol('requestOT'), totalLeave.toString(), ''].map(csvCell).join(',') + '\r\n';

      const thaiMonths = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
      const fileName = `Summary_OT_${thaiMonths[summary.targetMonth]}_${summary.targetYear + 543}.csv`;

      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      const url = URL.createObjectURL(blob);
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 1000);

      try { CloudStorage.showSyncToast(`✅ ส่งออกไฟล์ ${fileName} แล้ว (${summary.rows.length} รายการ)`, false); } catch(e) {}
  };

  // =====================================================================
  // ระบบสิทธิ์ผู้ใช้ (Guest / Driver / Admin)
  // =====================================================================
  const AUTH_KEY = 'egat_auth_user';
  const AUTH_ACCOUNTS_KEY = 'egat_auth_accounts';
  const ADMIN_PIN_DEFAULT = '1234';                 // PIN แอดมิน (ค่าเริ่มต้น)
  const ADMIN_PIN_KEY = 'egat_admin_pin';           // คีย์เก็บ PIN แอดมินใน LocalStorage

  function getAdminPin() {
      try {
          return localStorage.getItem(ADMIN_PIN_KEY) || ADMIN_PIN_DEFAULT;
      } catch(e) {
          return ADMIN_PIN_DEFAULT;
      }
  }

  function setAdminPin(newPin) {
      try {
          localStorage.setItem(ADMIN_PIN_KEY, String(newPin));
          return true;
      } catch(e) {
          return false;
      }
  }
  const AUTH_SESSION_KEY = 'egat_auth_session';
  const AUTH_REGISTRY_KEY = 'egat_auth_registry';   // ทะเบียนบัญชี พขร. (เก็บ PIN แบบ hash)

  // hash แบบเรียบง่าย (FNV-1a) — ไม่ใช่การเข้ารหัสจริง แต่ไม่เก็บ PIN เป็นข้อความตรงๆ
  function simpleHash(str) {
      let h = 2166136261;
      const s = String(str);
      for (let i = 0; i < s.length; i++) {
          h ^= s.charCodeAt(i);
          h = Math.imul(h, 16777619);
      }
      return (h >>> 0).toString(16);
  }

  const Auth = {
      // user = { role:'admin', name:'...' } | { role:'driver', name:'นายก' } | null
      user: null,

      isGuest: function() { return !this.user; },
      isDriver: function() { return !!this.user && this.user.role === 'driver'; },
      isAdmin: function() { return !!this.user && this.user.role === 'admin'; },
      canWrite: function() { return !!this.user; },      // บันทึกได้เมื่อล็อกอินแล้วเท่านั้น
      currentName: function() { return this.user ? this.user.name : ''; },

      load: function() {
          try {
              const raw = localStorage.getItem(AUTH_SESSION_KEY);
              const parsed = raw ? JSON.parse(raw) : null;
              this.user = (parsed && (parsed.role === 'admin' || parsed.role === 'driver') && parsed.name)
                  ? parsed : null;
          } catch(e) { this.user = null; }
      },

      save: function() {
          try {
              if (this.user) localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(this.user));
              else localStorage.removeItem(AUTH_SESSION_KEY);
          } catch(e) {}
      },

      loginAdmin: function(pin) {
          if (String(pin) === getAdminPin()) {
              this.user = { role: 'admin', name: 'ผู้ดูแลระบบ' };
              this.save();
              return true;
          }
          return false;
      },

      loginDriver: function(name) {
          const clean = getPlainName(name);
          if (!clean) return false;
          // [SECURITY] บัญชีที่ยังไม่ผ่านการอนุมัติ ห้ามเข้าสู่ระบบแม้จะเรียกฟังก์ชันนี้ตรงๆ
          if (!this.isApproved(clean)) return false;
          this.user = { role: 'driver', name: clean };
          this.save();
          return true;
      },

      logout: function() { this.user = null; this.save(); },

      // รายชื่อที่เคยล็อกอิน (เก็บไว้ให้เลือกครั้งถัดไป)
      getKnownAccounts: function() {
          try {
              const parsed = JSON.parse(localStorage.getItem(AUTH_ACCOUNTS_KEY) || '[]');
              return Array.isArray(parsed) ? parsed : [];
          } catch(e) { return []; }
      },

      rememberAccount: function(name) {
          try {
              const clean = getPlainName(name);
              if (!clean) return;
              const list = this.getKnownAccounts();
              if (!list.includes(clean)) {
                  list.push(clean);
                  localStorage.setItem(AUTH_ACCOUNTS_KEY, JSON.stringify(list));
              }
          } catch(e) {}
      },

      // ผู้ใช้ที่ล็อกอิน (ไม่ใช่แอดมิน) เห็นข้อมูลของตัวเองเท่านั้น
      shouldSeeAllDrivers: function() { return this.isAdmin() || this.isGuest(); },

      // ===== ทะเบียนบัญชี พขร. (ผูกชื่อ + PIN) =====
      // โครงสร้าง: { "นายสมชาย": { pinHash: "xxxx", createdAt: "ISO" }, ... }
      getRegistry: function() {
          try {
              const parsed = JSON.parse(localStorage.getItem(AUTH_REGISTRY_KEY) || '{}');
              return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
          } catch(e) { return {}; }
      },

      hasAccount: function(name) {
          const clean = getPlainName(name);
          return !!clean && Object.prototype.hasOwnProperty.call(this.getRegistry(), clean);
      },

      // ลงทะเบียน/ผูก PIN ให้ชื่อ พขร. (ถ้ามี PIN เดิมอยู่แล้วต้องใส่ PIN เดิมยืนยัน)
      claimAccount: function(name, pin, currentPin) {
          const clean = getPlainName(name);
          if (!clean) return { ok: false, msg: 'กรุณากรอกชื่อ พขร.' };

          const pinStr = String(pin || '').trim();
          if (!/^\d{4}$/.test(pinStr)) {
              return { ok: false, msg: 'PIN ต้องเป็นตัวเลข 4 หลัก (เช่น 1234)' };
          }

          const reg = this.getRegistry();
          if (Object.prototype.hasOwnProperty.call(reg, clean) && reg[clean] && reg[clean].pinHash) {
              // [FIX] ชื่อนี้ผูก PIN แล้ว -> currentPin ต้องตรงกับ PIN เดิมที่บันทึกไว้
              // เดิมเทียบ currentPin กับ pin ใหม่ ทำให้ใครก็ทับ PIN เดิมได้ (เปราะมาก)
              if (simpleHash(String(currentPin || '').trim()) !== reg[clean].pinHash) {
                  return { ok: false, msg: 'ชื่อนี้ผูก PIN ไว้แล้ว กรุณากรอก PIN เดิม 4 หลักเพื่อยืนยัน' };
              }
          }

          reg[clean] = { pinHash: simpleHash(pinStr), createdAt: new Date().toISOString() };
          try { localStorage.setItem(AUTH_REGISTRY_KEY, JSON.stringify(reg)); } catch(e) {}

          this.rememberAccount(clean);
          return { ok: true, msg: 'ผูกบัญชีสำเร็จ' };
      },

      // ตรวจ PIN ของชื่อที่ระบุ — เว้นว่างได้ถ้าชื่อนั้นยังไม่เคยตั้ง PIN
      verifyPin: function(name, pin) {
          const clean = getPlainName(name);
          if (!clean) return false;

          // [FIX] ชื่อที่ไม่มีอยู่ในระบบต้องปฏิเสธเสมอ
          // เดิมคืน true เมื่อไม่พบรายการ ทำให้ใครก็ "ผ่าน" ได้
          const known = this.getSystemDriverNames();
          if (known.indexOf(clean) === -1 && !this.hasAccount(clean)) return false;

          const reg = this.getRegistry();
          const entry = reg[clean];
          if (!entry || !entry.pinHash) return true;   // ยังไม่ตั้ง PIN -> อนุญาต (ครั้งแรก)
          return simpleHash(String(pin || '').trim()) === entry.pinHash;
      },

      hasPin: function(name) {
          const reg = this.getRegistry();
          const clean = getPlainName(name);
          return !!(clean && reg[clean] && reg[clean].pinHash);
      },

      // รายชื่อ พขร. ทั้งหมดที่มีในฐานข้อมูลจริง (สำหรับ dropdown "ขอรับบัญชี")
      getSystemDriverNames: function() {
          const out = [];
          try {
              (drivers || []).forEach(d => {
                  const n = getPlainName(typeof d === 'string' ? d : (d && d.name));
                  // [FIX] บัญชีที่ถูกปฏิเสธ ต้องไม่โผล่ใน dropdown เข้าสู่ระบบ
                  if (n && out.indexOf(n) === -1 && !this.isRejected(n)) out.push(n);
              });
          } catch(e) {}
          // รวมชื่อที่เคยล็อกอิน แต่ยังไม่มีในรายชื่อหลัก
          this.getKnownAccounts().forEach(n => {
              if (out.indexOf(n) === -1 && !this.isRejected(n)) out.push(n);
          });
          return out;
      },

      // ตรวจสถานะอนุมัติของบัญชี
      // [RULE] ข้อมูลเก่าไม่มีฟิลด์นี้ = อนุมัติไว้แล้ว (ถือว่าคนเดิมใช้งานได้)
      // [RULE] บัญชีที่ถูกปฏิเสธ ห้ามเข้าใช้งานเด็ดขาด
      isRejected: function(name) {
          const entry = this.getRegistry()[getPlainName(name)];
          return !!(entry && entry.isRejected === true);
      },

      // [FIX] เดิมใช้ !entry => อนุมัติ ทำให้บัญชีที่ถูกปฏิเสธ (ซึ่งถูกลบออกจากทะเบียน)
      // กลับมาเป็น "อนุมัติ" และเข้าสู่ระบบได้อีก — ต้องเช็ค isRejected ด้วย
      isApproved: function(name) {
          const entry = this.getRegistry()[getPlainName(name)];
          if (!entry) return true;                 // ไม่เคยลงทะเบียน = ผู้ใช้เดิม = ใช้ได้
          if (entry.isRejected === true) return false;
          return entry.isApproved !== false;
      },

      // รายการบัญชีที่รออนุมัติ
      getPendingList: function() {
          const reg = this.getRegistry();
          return Object.keys(reg)
              .filter(n => reg[n] && reg[n].isApproved === false && reg[n].isRejected !== true)
              .map(n => ({ name: n, at: reg[n].createdAt || '' }));
      },

      // อนุมัติบัญชี
      approveAccount: function(name) {
          const clean = getPlainName(name);
          const reg = this.getRegistry();
          if (!reg[clean]) return { ok: false, msg: 'ไม่พบบัญชีนี้' };
          reg[clean].isApproved = true;
          reg[clean].isRejected = false;
          try { localStorage.setItem(AUTH_REGISTRY_KEY, JSON.stringify(reg)); } catch(e) {}
          return { ok: true, msg: 'อนุมัติบัญชี ' + clean + ' แล้ว' };
      },

      // [FIX] ปฏิเสธ = ทำเครื่องหมาย "เสีย" ไว้ ไม่ลบทิ้ง
      // ถ้าลบทิ้ง isApproved() จะคืน true แล้วผู้ที่ถูกปฏิเสธจะกลับมาเข้าสู่ระบบได้อีก
      rejectAccount: function(name) {
          const clean = getPlainName(name);
          const reg = this.getRegistry();
          if (!reg[clean]) return { ok: false, msg: 'ไม่พบบัญชีนี้' };
          reg[clean].isApproved = false;
          reg[clean].isRejected = true;
          reg[clean].rejectedAt = new Date().toISOString();
          try { localStorage.setItem(AUTH_REGISTRY_KEY, JSON.stringify(reg)); } catch(e) {}
          // ล้าง PIN ทิ้งเพื่อไม่ให้ใช้ PIN เดิมเข้าได้อีก
          delete reg[clean].pinHash;
          try { localStorage.setItem(AUTH_REGISTRY_KEY, JSON.stringify(reg)); } catch(e) {}
          return { ok: true, msg: 'ปฏิเสธบัญชี ' + clean + ' แล้ว' };
      },

      // แอดมินตั้ง/รีเซ็ต PIN ให้ พขร. ได้โดยไม่ต้องรู้ PIN เดิม
      // เก็บทั้ง hash (ไว้ตรวจ) และ plain (ไว้ให้ Admin ดู/ซ่อนด้วยตา)
      adminResetPin: function(name, newPin) {
          const clean = getPlainName(name);
          if (!clean) return { ok: false, msg: 'กรุณาเลือกชื่อ พขร.' };
          const pinStr = String(newPin || '').trim();
          if (!/^\d{4}$/.test(pinStr)) {
              return { ok: false, msg: 'PIN ต้องเป็นตัวเลข 4 หลัก' };
          }
          const reg = this.getRegistry();
          reg[clean] = reg[clean] || { createdAt: new Date().toISOString() };
          reg[clean].pinHash = simpleHash(pinStr);
          reg[clean].pin = pinStr;
          reg[clean].pinResetAt = new Date().toISOString();
          try { localStorage.setItem(AUTH_REGISTRY_KEY, JSON.stringify(reg)); } catch(e) {}
          this.rememberAccount(clean);
          return { ok: true, msg: 'ตั้ง PIN ใหม่ให้ ' + clean + ' แล้ว' };
      },

      // ดึง PIN 4 หลักจริงสำหรับ Admin (ถ้าไม่มี plain จะลอง brute-force 0000-9999 เทียบ hash)
      getDriverPin: function(name) {
          const clean = getPlainName(name);
          if (!clean) return '';
          const entry = this.getRegistry()[clean];
          if (!entry || !entry.pinHash) return '';
          if (entry.pin && /^\d{4}$/.test(String(entry.pin))) return String(entry.pin);
          for (let i = 0; i <= 9999; i++) {
              const cand = String(i).padStart(4, '0');
              if (simpleHash(cand) === entry.pinHash) {
                  entry.pin = cand;
                  try {
                      const reg = this.getRegistry();
                      reg[clean] = entry;
                      localStorage.setItem(AUTH_REGISTRY_KEY, JSON.stringify(reg));
                  } catch(e) {}
                  return cand;
              }
          }
          return '';
      },

      // ลงทะเบียนชื่อใหม่: เขียนแบบ "รออนุมัติ" (ยังเข้าใช้งานไม่ได้)
      requestNewDriver: function(name, extra) {
          const clean = getPlainName(name);
          if (!clean) return { ok: false, msg: 'กรุณากรอกชื่อ-นามสกุล' };
          if ((drivers || []).some(d => getPlainName(d && d.name) === clean)) {
              return { ok: false, msg: 'มีชื่อนี้อยู่ในระบบแล้ว กรุณาใช้ปุ่ม "ขอรับบัญชี" แทน' };
          }
          drivers.push({
              id: Date.now(),
              name: clean,
              nickname: (extra && extra.nickname) || '',
              phone: (extra && extra.phone) || '',
              affiliation: (extra && extra.affiliation) || '',
              department: (extra && extra.department) || ''
          });
          CloudStorage.setItem('egat_drivers', JSON.stringify(drivers));
          try { renderDrivers(); } catch(e) {}
          return { ok: true, msg: 'ส่งคำขอลงทะเบียนแล้ว' };
      },

      // เพิ่มชื่อใหม่เข้าฐานข้อมูล พขร. (ใช้ตอน "ลงทะเบียนชื่อใหม่")
      registerNewDriver: function(name, extra) {
          const clean = getPlainName(name);
          if (!clean) return { ok: false, msg: 'กรุณากรอกชื่อ-นามสกุล' };
          if ((drivers || []).some(d => getPlainName(d && d.name) === clean)) {
              return { ok: false, msg: 'มีชื่อนี้อยู่ในระบบแล้ว' };
          }
          drivers.push({
              id: Date.now(),
              name: clean,
              nickname: (extra && extra.nickname) || '',
              phone: (extra && extra.phone) || '',
              affiliation: (extra && extra.affiliation) || '',
              department: (extra && extra.department) || ''
          });
          CloudStorage.setItem('egat_drivers', JSON.stringify(drivers));
          try { renderDrivers(); } catch(e) {}
          return { ok: true, msg: 'เพิ่มชื่อลงฐานข้อมูลแล้ว' };
      }
  };
  Auth.load();

  window.Auth = Auth;

  // ---------- Modal ล็อกอิน (Segmented Tab: พขร. / Admin) ----------
  let loginTab = 'driver';
  window.switchLoginTab = function(role) {
      loginTab = (role === 'admin') ? 'admin' : 'driver';
      const paneD = document.getElementById('loginPaneDriver');
      const paneA = document.getElementById('loginPaneAdmin');
      const btnD = document.getElementById('segDriverBtn');
      const btnA = document.getElementById('segAdminBtn');
      if (paneD) paneD.style.display = loginTab === 'driver' ? '' : 'none';
      if (paneA) paneA.style.display = loginTab === 'admin' ? '' : 'none';
      if (btnD) { btnD.classList.toggle('active', loginTab === 'driver'); btnD.setAttribute('aria-selected', loginTab === 'driver' ? 'true' : 'false'); }
      if (btnA) { btnA.classList.toggle('active', loginTab === 'admin'); btnA.setAttribute('aria-selected', loginTab === 'admin' ? 'true' : 'false'); }
      hidePendingNotice();
  };
  function showPendingNotice() {
      const n = document.getElementById('pendingNotice');
      if (n) n.style.display = '';
  }
  function hidePendingNotice() {
      const n = document.getElementById('pendingNotice');
      if (n) n.style.display = 'none';
  }
  // [FIX] ชื่อฟังก์ชันภายในต้องต่างจากชื่อที่ expose บน window
  // เดิม window.openLoginModal = function(){ openLoginModal(); }
  // ทำให้ตัวแปรเดียวกันถูกทับด้วยตัว wrapper เอง -> เรียกซ้ำไม่รู้จบ (infinite recursion)
  function showLoginModal(message) {
      const modal = document.getElementById('loginModal');
      if (!modal) return;
      const msgEl = document.getElementById('loginMessage');
      if (msgEl) msgEl.textContent = message
          || 'กรุณาเข้าสู่ระบบหรือสมัครสมาชิกก่อนบันทึกข้อมูล';

      const sel = document.getElementById('loginAccountSelect');
      if (sel) {
          // รายชื่อ พขร. ที่มีอยู่ในฐานข้อมูลจริง + ชื่อที่เคยล็อกอิน
          const systemNames = Auth.getSystemDriverNames();
          const claimed = Auth.getKnownAccounts();
          const unclaimed = systemNames.filter(n => claimed.indexOf(n) === -1);
          const parts = ['<option value="">— เลือกชื่อ พขร. ของคุณ —</option>'];
          if (claimed.length) {
              parts.push('<optgroup label="บัญชีที่เคยล็อกอิน">'
                  + claimed.map(n => '<option value="' + n + '">' + n + '</option>').join('') + '</optgroup>');
          }
          if (unclaimed.length) {
              parts.push('<optgroup label="รายชื่อ พขร. ในระบบ (ขอรับบัญชี)">'
                  + unclaimed.map(n => '<option value="' + n + '">' + n + '</option>').join('') + '</optgroup>');
          }
          if (systemNames.length === 0) {
              parts.push('<option value="">— ยังไม่มีรายชื่อในระบบ —</option>');
          }
          sel.innerHTML = parts.join('');
      }
      ['loginAdminPin', 'loginDriverPin', 'loginCurrentPin',
       'loginNewDriverName', 'loginNewNickname', 'loginNewPhone'].forEach(id => {
          const i = document.getElementById(id);
          if (i) i.value = '';
      });

      // ค่าเริ่มต้นเป็นโหมด "ขอรับบัญชี" + แท็บ พขร. + ซ่อนแจ้งเตือนรออนุมัติ
      setClaimMode(true);
      try { window.switchLoginTab('driver'); } catch(e) {}
      hidePendingNotice();

      modal.classList.add('show');
  }

  // สลับโหมด: true = ขอรับบัญชี (ชื่อเดิม + PIN) | false = ลงทะเบียนชื่อใหม่
  function setClaimMode(claimMode) {
      const box = document.getElementById('claimModeBox');
      const boxNew = document.getElementById('registerModeBox');
      const btn = document.getElementById('btnToggleRegisterMode');
      if (box) box.style.display = claimMode ? '' : 'none';
      if (boxNew) boxNew.style.display = claimMode ? 'none' : '';
      if (btn) {
          btn.textContent = claimMode
              ? '➕ ไม่พบชื่อของฉันในระบบ? ลงทะเบียนชื่อใหม่'
              : '↩️ กลับไปเลือกชื่อที่มีอยู่ในระบบ';
      }
  }
  window.setClaimMode = setClaimMode;

  function toggleRegisterMode() {
      const box = document.getElementById('claimModeBox');
      const isHidden = box && box.style.display === 'none';
      setClaimMode(isHidden);
  }
  window.toggleRegisterMode = toggleRegisterMode;

  function hideLoginModal() {
      const modal = document.getElementById('loginModal');
      if (modal) modal.classList.remove('show');
  }

  window.openLoginModal = function(msg) { showLoginModal(msg); };
  window.closeLoginModal = function() { hideLoginModal(); };

  // ---------- ล็อกอิน / ขอรับบัญชี พขร. ----------
  // โหมด 1: เลือกชื่อเดิมในระบบ + (ถ้าเคยตั้ง PIN แล้วต้องใส่ PIN ถูก)
  function attemptClaimLogin() {
      const sel = document.getElementById('loginAccountSelect');
      const pinInp = document.getElementById('loginDriverPin');
      const name = sel ? getPlainName(sel.value) : '';
      if (!name) { alert('⚠️ กรุณาเลือก "ชื่อ พขร." ของคุณจากรายการครับ'); return; }

      // [NEW] บัญชีใหม่ต้องรอ Admin อนุมัติก่อนจึงจะเข้าสู่ระบบได้ -> โชว์การ์ดส้มมินิมอล
      if (!Auth.isApproved(name)) {
          showPendingNotice();
          return;
      }
      hidePendingNotice();

      const pin = pinInp ? String(pinInp.value).trim() : '';

      if (Auth.hasPin(name)) {
          // ตั้ง PIN ไว้แล้ว -> ต้องใส่ PIN ให้ถูก
          if (!/^\d{4}$/.test(pin)) {
              alert('⚠️ กรุณาใส่ PIN ส่วนตัว 4 หลักของคุณ');
              if (pinInp) { pinInp.value = ''; pinInp.focus(); }
              return;
          }
          if (!Auth.verifyPin(name, pin)) {
              alert('❌ PIN ไม่ถูกต้องครับ');
              if (pinInp) { pinInp.value = ''; pinInp.focus(); }
              return;
          }
          finishDriverLogin(name, 'ยินดีต้อนรับกลับมา');
          return;
      }

      // ยังไม่เคยตั้ง PIN -> ครั้งแรกให้ตั้ง PIN เลย
      if (!/^\d{4}$/.test(pin)) {
          alert('⚠️ กรุณาตั้ง PIN ส่วนตัว 4 หลัก (ตัวเลข) สำหรับเข้าสู่ระบบครั้งถัดไป');
          if (pinInp) { pinInp.focus(); }
          return;
      }
      const res = Auth.claimAccount(name, pin, pin);
      if (!res.ok) { alert('❌ ' + res.msg); return; }

      finishDriverLogin(name, 'ตั้ง PIN เรียบร้อย — เข้าสู่ระบบได้แล้ว');
  }

  // โหมด 2: ลงทะเบียนชื่อใหม่ — บันทึกเป็น "รออนุมัติ" เท่านั้น ยังเข้าใช้งานไม่ได้
  function attemptRegisterNew() {
      const nameInp = document.getElementById('loginNewDriverName');
      const nickInp = document.getElementById('loginNewNickname');
      const phoneInp = document.getElementById('loginNewPhone');
      const pinInp = document.getElementById('loginRegisterPin');

      const name = nameInp ? getPlainName(nameInp.value) : '';
      const nick = nickInp ? nickInp.value.trim() : '';
      const phone = phoneInp ? phoneInp.value.trim() : '';
      const pin = pinInp ? String(pinInp.value).trim() : '';

      // [NEW] บังคับกรอกครบทุกช่อง
      if (!name) { alert('⚠️ กรุณากรอก "ชื่อ-นามสกุล" ครับ'); focusOf(nameInp); return; }
      if (!nick) { alert('⚠️ กรุณากรอก "ชื่อเล่น" ครับ'); focusOf(nickInp); return; }
      if (!phone) { alert('⚠️ กรุณากรอก "เบอร์โทรศัพท์" ครับ'); focusOf(phoneInp); return; }
      if (!/^\d{4}$/.test(pin)) {
          alert('⚠️ กรุณาตั้ง PIN ส่วนตัว 4 หลัก (ตัวเลข) ครับ');
          focusOf(pinInp);
          return;
      }

      const reg = Auth.requestNewDriver(name, { nickname: nick, phone: phone });
      if (!reg.ok) { alert('❌ ' + reg.msg); return; }

      // [NEW] ผูก PIN แต่ตั้งสถานะเป็น "รออนุมัติ"
      const claim = Auth.claimAccount(name, pin, '');
      if (!claim.ok) { alert('❌ ' + claim.msg); return; }

      const regStore = Auth.getRegistry();
      if (regStore[getPlainName(name)]) {
          regStore[getPlainName(name)].isApproved = false;
          try { localStorage.setItem('egat_auth_registry', JSON.stringify(regStore)); } catch(e) {}
      }

      setClaimMode(true);
      // ล้างฟอร์ม
      ['loginNewDriverName', 'loginNewNickname', 'loginNewPhone', 'loginRegisterPin']
          .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });

      alert('✅ ลงทะเบียนสำเร็จ!\n\n'
          + 'บัญชีของคุณอยู่สถานะ "รอ Admin อนุมัติ"\n'
          + 'กรุณารอผู้ดูแลระบบอนุมัติก่อน จึงจะเข้าสู่ระบบได้\n\n'
          + 'หลังได้รับอนุมัติแล้ว ให้กลับมาเลือกชื่อของคุณในหน้า "เข้าสู่ระบบ"');
  }

  function focusOf(el) { if (el && el.focus) el.focus(); }

  function finishDriverLogin(name, message) {
      Auth.loginDriver(name);
      Auth.rememberAccount(name);
      hideLoginModal();
      // [SYNC FIX] โหลดสถานะล่าสุดที่ Admin ตั้งไว้ก่อน render หน้าสรุปของ พขร.
      try { reloadVerifyStatus(); } catch(e) {}
      applyAuthRestrictions();
      alert('✅ ' + message + '\nยินดีต้อนรับ ' + Auth.currentName() + '\nบันทึกข้อมูลได้แล้ว');
  }

  window.attemptClaimLogin = attemptClaimLogin;
  window.attemptRegisterNew = attemptRegisterNew;
  window.attemptDriverLogin = attemptClaimLogin;      // alias รักษาชื่อเดิมไว้

  window.attemptAdminLogin = function() {
      const pinInp = document.getElementById('loginAdminPin');
      if (Auth.loginAdmin(pinInp ? pinInp.value : '')) {
          hideLoginModal();
          applyAuthRestrictions();
          alert('✅ ยินดีต้อนรับผู้ดูแลระบบ\nเลือกชื่อ พขร. ได้ทุกคน และดูข้อมูลทั้งหมด');
      } else {
          alert('❌ PIN ไม่ถูกต้องครับ');
          if (pinInp) { pinInp.value = ''; pinInp.focus(); }
      }
  };

  window.logoutUser = function() {
      if (!confirm('ต้องการออกจากระบบใช่หรือไม่?')) return;
      Auth.logout();
      applyAuthRestrictions();
      alert('✅ ออกจากระบบแล้ว (เข้าสู่โหมดผู้เยี่ยมชม)');
  };

  // ตรวจสิทธิ์ก่อนบันทึกข้อมูล
  function requireLogin(actionLabel) {
      if (Auth.canWrite()) return true;
      showLoginModal('กรุณาเข้าสู่ระบบหรือสมัครสมาชิกก่อน' + (actionLabel ? ' ' + actionLabel : '')
          + '\n(ผู้เยี่ยมชมคำนวณได้ แต่บันทึกข้อมูลไม่ได้)');
      return false;
  }
  window.requireLogin = requireLogin;

  // [AUTH] กรองข้อมูลตามสิทธิ์ก่อนนำไปแสดงผล/คำนวณ
  // พขร. ที่ล็อกอิน -> เห็นเฉพาะข้อมูลของตัวเอง | แอดมิน & ผู้เยี่ยมชม -> เห็นทั้งหมด
  // เรียกครั้งเดียวที่ต้น renderHistory() เพื่อให้ครอบคลุมทุกโหมด (ปกติ/รวมพขร.)
  function scopeHistoryForAuth(list) {
      if (typeof Auth === 'undefined' || Auth.shouldSeeAllDrivers()) return list;
      const me = Auth.currentName();
      if (!me) return list;
      return (list || []).filter(item => getPlainName(item.driver) === me);
  }

  // [AUTH] ป้ายบอกสถานะที่หัวตารางสรุป
  function renderAuthScopeNotice() {
      const el = document.getElementById('authScopeNotice');
      if (!el) return;
      if (typeof Auth !== 'undefined' && Auth.isDriver()) {
          el.style.display = 'block';
          el.textContent = `🔒 กำลังดูข้อมูลของ ${Auth.currentName()} เท่านั้น`;
      } else {
          el.style.display = 'none';
      }
  }

  // เรียกทุกครั้งที่สถานะการล็อกอินเปลี่ยน — ปรับ UI ตามสิทธิ์
  function applyAuthRestrictions() {
      const guest = Auth.isGuest();
      const admin = Auth.isAdmin();

      // 1) Sidebar: ซ่อน "รายชื่อ พขร." และ "สำรอง/นำเข้าข้อมูล" (เหลือเฉพาะแอดมิน)
      // ใช้ getElementById ก่อน (เสถียรกว่า selector ที่ผูกกับ onclick)
      const menuDrivers = document.getElementById('menuDrivers')
          || document.querySelector('#menu .menu-item[onclick*="drivers"]');
      if (menuDrivers) menuDrivers.style.display = admin ? '' : 'none';
      const menuBackup = document.getElementById('menuBackup');
      if (menuBackup) menuBackup.style.display = admin ? '' : 'none';

      // 2) "สรุป พขร. (ยอดรวม)" เห็นเฉพาะแอดมิน (ผู้ใช้ทั่วไปดูสรุปรายเดือนปกติแทน)
      const driverModeBtn = document.querySelector('#summaryMenu .menu-opt[data-mode="driver"]');
      const driverModeLink = document.querySelector('#history-submenu .submenu-item[onclick*="driver"]');
      const tabDriverBtn = document.getElementById('btnModeDriver');
      if (driverModeBtn) driverModeBtn.style.display = admin ? '' : 'none';
      if (driverModeLink) driverModeLink.style.display = admin ? '' : 'none';
      if (tabDriverBtn) tabDriverBtn.style.display = admin ? 'inline-flex' : 'none';

      // [NEW] Guest: ซ่อนเมนู "สรุปรายเดือน" ทั้งหมด (เหลือคำนวณ OT + เครื่องคิดเลข)
      const menuHistory = document.getElementById('menuHistory') || document.querySelector('#menu .menu-item-group');
      if (menuHistory) menuHistory.style.display = guest ? 'none' : '';

      // [NEW] เมนู Admin Dashboard เห็นเฉพาะแอดมิน
      const menuAdmin = document.getElementById('menuAdmin');
      if (menuAdmin) menuAdmin.style.display = admin ? '' : 'none';

      // [NEW] เมนู "โปรไฟล์ของฉัน" เห็นเฉพาะสิทธิ์ พขร. (ซ่อนเมื่อเป็น Admin/Guest)
      const menuProfile = document.getElementById('menuProfile');
      if (menuProfile) menuProfile.style.display = (guest || admin) ? 'none' : '';

      // 3) ปุ่มสถานะบัญชี
      const statusText = document.getElementById('authStatusText');
      if (statusText) {
          statusText.textContent = guest ? '👤 ผู้เยี่ยมชม'
              : (admin ? '🛡️ ผู้ดูแลระบบ' : '👷 ' + Auth.currentName());
      }
      const statusBtn = document.getElementById('authStatusBtn');
      if (statusBtn) {
          statusBtn.innerHTML = guest
              ? '<span class="icon">🔓</span><span class="label">เข้าสู่ระบบ</span>'
              : '<span class="icon">🚪</span><span class="label">ออกจากระบบ</span>';
          statusBtn.onclick = guest
              ? function() { showLoginModal(); }
              : function() { window.logoutUser(); };
      }

      // 4) ล็อกช่องเลือกชื่อ พขร. ให้เป็นชื่อของคนที่ล็อกอิน
      const driverSelect = document.getElementById('driverSelect');
      if (driverSelect) {
          if (Auth.isDriver()) {
              driverSelect.value = Auth.currentName();
              driverSelect.disabled = true;
              driverSelect.style.background = '#f1f5f9';
              driverSelect.style.cursor = 'not-allowed';
              driverSelect.title = 'ล็อกชื่อของคุณ (' + Auth.currentName() + ') — เปลี่ยนไม่ได้';
          } else {
              driverSelect.disabled = false;
              driverSelect.style.background = '';
              driverSelect.style.cursor = '';
              driverSelect.removeAttribute('title');
          }
      }

      // 4.1) [NEW] หน้าสรุปรายเดือน (view-history):
      // ถ้าไม่ใช่แอดมิน (พขร. ทั่วไป) -> ซ่อนช่องค้นหาชื่อ พขร. ทั้งกลุ่ม เพราะข้อมูลถูกล็อคตามชื่อตัวเองอยู่แล้ว
      const historyDriverFilterGroup = document.getElementById('historyDriverFilterGroup');
      if (historyDriverFilterGroup) {
          historyDriverFilterGroup.style.display = admin ? 'flex' : 'none';
      }
      const historyDriverInput = document.getElementById('historyDriverFilter');
      if (historyDriverInput) {
          if (Auth.isDriver()) {
              historyDriverInput.value = Auth.currentName();
              if (historyFilters && historyFilters.daily) historyFilters.daily.driver = Auth.currentName();
          } else if (guest) {
              historyDriverInput.value = '';
          }
      }

      // 4.2) [AUTH] แถบเครื่องมือสรุปรายเดือน: ปุ่มแจ้งขาดและสรุปตาม เฉพาะแอดมินเท่านั้น
      const btnTbInc = document.getElementById('btnToolbarIncomplete');
      if (btnTbInc) btnTbInc.style.display = admin ? '' : 'none';
      const btnTbFol = document.getElementById('btnToolbarFollowUp');
      if (btnTbFol) btnTbFol.style.display = admin ? '' : 'none';

      // 5) ปุ่มบันทึก: แจ้งว่าต้องล็อกอินก่อน
      const saveBtn = document.getElementById('btnSaveLog');
      if (saveBtn) {
          saveBtn.title = guest ? 'ต้องเข้าสู่ระบบก่อนจึงจะบันทึกข้อมูลได้' : '';
      }

      // 6) ถ้าอยู่ในหน้าที่ถูกซ่อนอยู่ ให้พากลับหน้าคำนวณ
      const driversView = document.getElementById('view-drivers');
      if (!admin && driversView && driversView.classList.contains('active')) {
          switchView('ot');
      }
      // Guest ห้ามเข้าหน้าสรุปรายเดือน / Admin
      const historyView = document.getElementById('view-history');
      if (guest && historyView && historyView.classList.contains('active')) {
          switchView('ot');
      }
      const adminView = document.getElementById('view-admin');
      if (guest && adminView && adminView.classList.contains('active')) {
          switchView('ot');
      }
      if (!admin && currentHistoryMode === 'driver') {
          currentHistoryMode = 'daily';
          const dailyBtn = document.querySelector('#summaryMenu .menu-opt[data-mode="daily"]');
          if (dailyBtn && dailyBtn.click) dailyBtn.click();
          else { try { renderHistory(); } catch(e) {} }
      }

      // 7) รีเฟรชตารางให้เห็นเฉพาะข้อมูลของตัวเอง
      try { renderHistory(); } catch(e) {}
  }
  window.applyAuthRestrictions = applyAuthRestrictions;

  window.openAdvancedModal = function() {
      const isAdmin = (typeof Auth !== 'undefined' && Auth.isAdmin());
      const isDriver = (typeof Auth !== 'undefined' && Auth.isDriver());
      const btnAdminPin = document.getElementById('btnAdvAdminPin');
      const btnDriverPin = document.getElementById('btnAdvDriverPin');
      if (btnAdminPin) btnAdminPin.style.display = isAdmin ? 'block' : 'none';
      if (btnDriverPin) btnDriverPin.style.display = isDriver ? 'block' : 'none';
      document.getElementById('advancedModal').classList.add('show');
  };
  window.closeAdvancedModal = function() {
      document.getElementById('advancedModal').classList.remove('show');
  };

  window.onclick = function(event) {
      const modal = document.getElementById('detailModal');
      const deleteModal = document.getElementById('deleteOptionModal');
      const resetModal = document.getElementById('resetOptionModal');
      const summaryModal = document.getElementById('summaryModal');
      const incompleteModal = document.getElementById('incompleteModal');
      const driverModal = document.getElementById('addDriverModal');
      const createOptModal = document.getElementById('createOptionModal');
      const customMonthModal = document.getElementById('customMonthPickerModal');
      const backupModal = document.getElementById('backupModal');
      const quickSummaryModal = document.getElementById('quickSummaryModal');
      const advancedModal = document.getElementById('advancedModal'); 
      const leaveModal = document.getElementById('leaveModal');
      
      const loginModal = document.getElementById('loginModal');
      if (event.target == loginModal) hideLoginModal();

      const profileModal = document.getElementById('profileModal');
      if (event.target == profileModal) { closeProfileModal(); }

      const pinModal = document.getElementById('pinModal');
      if (event.target == pinModal) { try { closePinModal(); } catch(e) {} }

      const adminPinModal = document.getElementById('adminPinModal');
      if (event.target == adminPinModal) { try { closeAdminPinModal(); } catch(e) {} }

      const approvalModal = document.getElementById('approvalModal');
      if (event.target == approvalModal) { try { closeApprovalModal(); } catch(e) {} }

      if (event.target == modal) closeModal();
      if (event.target == deleteModal) closeDeleteModal();
      if (event.target == resetModal) closeResetModal();
      if (event.target == summaryModal) closeSummaryModal();
      if (event.target == incompleteModal) closeIncompleteModal();
      if (event.target == leaveModal) closeLeaveModal();
      if (event.target == driverModal) closeAddDriverModal();
      if (event.target == createOptModal) closeCreateOptionModal();
      if (event.target == customMonthModal) closeCustomMonthPicker();
      if (event.target == backupModal) closeBackupModal();
      if (event.target == quickSummaryModal) closeQuickSummaryModal();
      if (event.target == advancedModal) closeAdvancedModal(); 
      
      if (!event.target.closest('#historyTitleBtn')) {
          const menu = document.getElementById('summaryMenu');
          if (menu && menu.classList.contains('show')) {
              menu.classList.remove('show');
          }
      }
  };
   
  function openCustomMonthPicker(inputId, displayId) {
    pickerTargetId = inputId;
    pickerDisplayId = displayId;
    
    const input = document.getElementById(inputId);
    let initVal = (input && input.value && /^\d{4}-\d{2}$/.test(input.value)) ? input.value : getGlobalSelectedMonth();
    if(initVal && /^\d{4}-\d{2}$/.test(initVal)) {
        const [y, m] = initVal.split('-');
        pickerCurrentDate = new Date(parseInt(y), parseInt(m)-1, 1);
    } else {
        pickerCurrentDate = new Date();
    }
    
    renderCustomPicker();
    document.getElementById('customMonthPickerModal').classList.add('show');
  }

  function closeCustomMonthPicker() {
    document.getElementById('customMonthPickerModal').classList.remove('show');
  }

  function adjustPickerYear(offset) {
    pickerCurrentDate.setFullYear(pickerCurrentDate.getFullYear() + offset);
    renderCustomPicker();
  }

  function renderCustomPicker() {
    const year = pickerCurrentDate.getFullYear();
    const thaiYear = year + 543;
    document.getElementById('cmpYearDisplay').innerText = thaiYear;
    
    const grid = document.getElementById('cmpMonthGrid');
    grid.innerHTML = '';
    
    THAI_MONTHS_SHORT.forEach((m, idx) => {
        const btn = document.createElement('div');
        btn.className = 'cmp-month-btn';
        btn.innerText = m;
        const input = document.getElementById(pickerTargetId);
        let curVal = (input && input.value && /^\d{4}-\d{2}$/.test(input.value)) ? input.value : getGlobalSelectedMonth();
        if(curVal) {
             const [y, mStr] = curVal.split('-');
             if(parseInt(y) === year && (parseInt(mStr)-1) === idx) {
                 btn.classList.add('active');
             }
        }
        
        btn.onclick = () => selectPickerMonth(idx);
        grid.appendChild(btn);
    });
  }

  function selectPickerMonth(mIndex) {
    const year = pickerCurrentDate.getFullYear();
    const month = String(mIndex + 1).padStart(2, '0');
    const val = `${year}-${month}`;
    
    if (pickerTargetId === 'createTargetMonth') {
        const input = document.getElementById('createTargetMonth');
        if (input) input.value = val;
        updateCreateMonthDisplay(val);
    } else {
        setGlobalSelectedMonth(val);
        if (pickerTargetId === 'historyMonthPicker') {
            renderHistory();
        } else if (pickerTargetId === 'adminMonthPicker') {
            renderAdminDashboard();
        }
    }
    
    closeCustomMonthPicker();
  }

  window.stepMonth = function(delta) {
      const curKey = getGlobalSelectedMonth();
      let [y, m] = String(curKey).split('-').map(Number);
      if (!y || !m) {
          const d = new Date();
          y = d.getFullYear();
          m = d.getMonth() + 1;
      }
      m += delta;
      if (m < 1) { m = 12; y--; }
      else if (m > 12) { m = 1; y++; }
      const newKey = `${y}-${String(m).padStart(2, '0')}`;
      showAll = false;
      setGlobalSelectedMonth(newKey);
      renderHistory();
  };

  function setHistoryMode(mode) {
      const dropdown = document.getElementById('historyDriverFilter');
      const monthPicker = document.getElementById('historyMonthPicker');
      
      if(dropdown) {
          historyFilters[currentHistoryMode].driver = dropdown.value;
      }
      if(monthPicker) {
          historyFilters[currentHistoryMode].month = monthPicker.value;
      }

      currentHistoryMode = mode;

      // อัปเดตไฮไลต์ปุ่ม Segmented Tabs
      const btnDaily = document.getElementById('btnModeDaily');
      const btnDriver = document.getElementById('btnModeDriver');
      if (btnDaily) btnDaily.classList.toggle('active', mode === 'daily');
      if (btnDriver) btnDriver.classList.toggle('active', mode === 'driver');
      
      const titleText = document.getElementById('historyTitleBtn');
      if(titleText) {
          if(mode === 'daily') {
              titleText.innerText = "📊 สรุปรายเดือน";
          } else {
              titleText.innerText = "👥 สรุปตามรายเดือน พขร.";
          }
      }
      
      document.querySelectorAll('.submenu-item').forEach(el => el.classList.remove('active'));
      
      const btnExport = document.getElementById('btnExportCSV');
      if (btnExport) {
          btnExport.style.display = mode === 'driver' ? 'inline-flex' : 'none';
      }
      
      const toolbar = document.getElementById('historyToolbar');
      if(toolbar) {
          toolbar.style.display = mode === 'daily' ? 'flex' : 'none';
      }

      if(dropdown) {
          if (typeof Auth !== 'undefined' && Auth.isDriver()) {
              dropdown.value = Auth.currentName();
          } else {
              dropdown.value = historyFilters[mode].driver || "";
          }
      }
      const filterGroup = document.getElementById('historyDriverFilterGroup');
      if (filterGroup && typeof Auth !== 'undefined') {
          filterGroup.style.display = Auth.isAdmin() ? 'flex' : 'none';
      }
      if(monthPicker) {
          const currentMonth = getGlobalSelectedMonth();
          monthPicker.value = currentMonth;
          const display = document.getElementById('historyDateDisplay');
          if(display) display.innerText = getThaiMonthYearFull(currentMonth);
      }

      renderHistory();
  }
  window.setHistoryMode = setHistoryMode;

  function handleFilterChange() {
      const dropdown = document.getElementById('historyDriverFilter');
      if(dropdown) {
          historyFilters[currentHistoryMode].driver = dropdown.value;
      }
      renderHistory();
  }

  function formatThaiDateDisplay(dateStr) {
    if(!dateStr) return 'เลือกวันที่...';
    const d = new Date(dateStr);
    if(isNaN(d.getTime())) return 'เลือกวันที่...';
      
    const months = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
    const day = d.getDate();
    const month = months[d.getMonth()];
    const year = (d.getFullYear() + 543) % 100;
      
    return `${day} ${month} ${year}`;
  }
   
  function getThaiMonthYearFull(dateStr) {
       if(!dateStr) return '...';
      const [y, m] = dateStr.split('-');
      if(!y || !m) return '...';
      const months = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
      return `${months[parseInt(m)-1]} ${parseInt(y)+543}`;
  }

  // [SINGLE SOURCE OF TRUTH] ซิงค์เดือนที่เลือกตรงกันทุกส่วน (Admin Dashboard, สรุปรายเดือน, Quick Summary)
  function getGlobalSelectedMonth() {
      let saved = null;
      try {
          saved = CloudStorage.getItem('egat_selected_month');
          if (!saved || !/^\d{4}-\d{2}$/.test(saved)) {
              saved = CloudStorage.getItem('egat_admin_month');
          }
      } catch(e) {}

      // ฟังก์ชันหาเดือนล่าสุดที่มีข้อมูล OT จริง (ไม่นับแถวแม่แบบว่างเปล่า/แบบร่าง)
      const findLatestActiveMonth = () => {
          if (!Array.isArray(otHistory) || otHistory.length === 0) return null;
          for (let i = otHistory.length - 1; i >= 0; i--) {
              const it = otHistory[i];
              if (it && it.date && /^\d{4}-\d{2}/.test(it.date)) {
                  if (!it.isPending && (it.ot15 > 0 || it.ot1 > 0 || it.ot3 > 0 || it.isLeave || parseFloat(it.requestOT) > 0)) {
                      return it.date.substring(0, 7);
                  }
              }
          }
          return null;
      };

      const latestActive = findLatestActiveMonth();

      // ถ้าค่า saved ชี้ไปเดือนอนาคตที่ไม่มีข้อมูลจริงเลย แต่มีเดือนที่มีข้อมูลจริง ให้เลือกเดือนที่มีข้อมูลจริงก่อน
      if (saved && /^\d{4}-\d{2}$/.test(saved)) {
          if (latestActive && saved > latestActive) {
              const hasActualData = otHistory.some(it => it && it.date && it.date.startsWith(saved) && !it.isPending && (it.ot15 > 0 || it.ot1 > 0 || it.ot3 > 0 || it.isLeave));
              if (hasActualData) return saved;
              return latestActive;
          }
          return saved;
      }

      if (latestActive) return latestActive;

      // ถ้าไม่มีข้อมูลจริงเลย ให้หาเดือนของรายการล่าสุดในประวัติ
      if (Array.isArray(otHistory) && otHistory.length > 0) {
          for (let i = otHistory.length - 1; i >= 0; i--) {
              const it = otHistory[i];
              if (it && it.date && /^\d{4}-\d{2}/.test(it.date)) {
                  return it.date.substring(0, 7);
              }
          }
      }
      const now = new Date();
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }
  window.getGlobalSelectedMonth = getGlobalSelectedMonth;

  function setGlobalSelectedMonth(monthKey) {
      if (!monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) return;
      try {
          CloudStorage.setItem('egat_selected_month', monthKey);
          CloudStorage.setItem('egat_admin_month', monthKey);
      } catch(e) {}
      if (typeof historyFilters !== 'undefined') {
          if (!historyFilters.daily) historyFilters.daily = {};
          if (!historyFilters.driver) historyFilters.driver = {};
          historyFilters.daily.month = monthKey;
          historyFilters.driver.month = monthKey;
      }
      const histPicker = document.getElementById('historyMonthPicker');
      if (histPicker) histPicker.value = monthKey;
      const histDisplay = document.getElementById('historyDateDisplay');
      if (histDisplay && typeof getThaiMonthYearFull === 'function') {
          histDisplay.innerText = getThaiMonthYearFull(monthKey);
      }
      const adminPicker = document.getElementById('adminMonthPicker');
      if (adminPicker) adminPicker.value = monthKey;
      const adminDisplay = document.getElementById('adminMonthDisplay');
      if (adminDisplay && typeof getThaiMonthYearFull === 'function') {
          adminDisplay.innerText = getThaiMonthYearFull(monthKey);
      }
  }
  window.setGlobalSelectedMonth = setGlobalSelectedMonth;

  // ฟังก์ชันแยกปี-เดือน จากสตริงวันที่ทุกรูปแบบ (ISO, พ.ศ., DD/MM/YYYY, ข้อความภาษาไทย)
  function extractYearMonthFromDate(val) {
      if (!val) return null;
      if (typeof val !== 'string') {
          if (val instanceof Date && !isNaN(val.getTime())) {
              let y = val.getFullYear();
              if (y > 2400) y -= 543;
              return { year: y, month: val.getMonth() + 1 };
          }
          val = String(val);
      }
      val = val.trim();
      if (!val) return null;

      // 1. รูปแบบ YYYY-MM-DD หรือ YYYY/MM/DD หรือ YYYY-MM
      let mIso = val.match(/^(\d{4})[-\/](\d{1,2})/);
      if (mIso) {
          let y = parseInt(mIso[1], 10);
          let m = parseInt(mIso[2], 10);
          if (y > 2400) y -= 543;
          if (m >= 1 && m <= 12) return { year: y, month: m };
      }

      // 2. รูปแบบ DD/MM/YYYY หรือ DD-MM-YYYY
      let mDmy = val.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/);
      if (mDmy) {
          let m = parseInt(mDmy[2], 10);
          let y = parseInt(mDmy[3], 10);
          if (y > 2400) y -= 543;
          if (m >= 1 && m <= 12) return { year: y, month: m };
      }

      // 3. รูปแบบชื่อเดือนภาษาไทย เช่น "16 ต.ค. 69" หรือ "ตุลาคม 2569"
      const thShort = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
      const thFull = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
      for (let i = 0; i < 12; i++) {
          if (val.includes(thShort[i]) || val.includes(thFull[i])) {
              const m = i + 1;
              const yMatch = val.match(/\d{2,4}/g);
              let y = new Date().getFullYear();
              if (yMatch && yMatch.length > 0) {
                  const lastNum = parseInt(yMatch[yMatch.length - 1], 10);
                  if (lastNum > 2400) y = lastNum - 543;
                  else if (lastNum >= 1900 && lastNum < 2200) y = lastNum;
                  else if (lastNum < 100) y = (lastNum + 2500) - 543;
              }
              return { year: y, month: m };
          }
      }

      // 4. Fallback: new Date(val)
      const d = new Date(val);
      if (!isNaN(d.getTime())) {
          let y = d.getFullYear();
          if (y > 2400) y -= 543;
          return { year: y, month: d.getMonth() + 1 };
      }

      return null;
  }
  window.extractYearMonthFromDate = extractYearMonthFromDate;

  // อ่านปี-เดือน จากช่องวันที่ของหน้าคำนวณ OT (รองรับทั้ง input, แสดงผล, และป้ายกำกับ)
  function getWorkDateSelectedMonth() {
      const dateInput = document.getElementById('workDate');
      if (dateInput && dateInput.value) {
          const res = extractYearMonthFromDate(dateInput.value);
          if (res) return res;
      }
      const showEl = document.getElementById('workDateShow');
      if (showEl && showEl.textContent) {
          const res = extractYearMonthFromDate(showEl.textContent);
          if (res) return res;
      }
      const labelEl = document.getElementById('dateLabel');
      if (labelEl && labelEl.textContent) {
          const res = extractYearMonthFromDate(labelEl.textContent);
          if (res) return res;
      }
      return null;
  }
  window.getWorkDateSelectedMonth = getWorkDateSelectedMonth;

  function updateCreateMonthDisplay(val) {
      const display = document.getElementById('createMonthDisplay');
      if(display) display.innerText = val ? getThaiMonthYearFull(val) : 'เลือกเดือน...';
  }

  function formatDateForInputBox(dateStr) {
    if(!dateStr) return 'เลือกวันที่...';
    const d = new Date(dateStr);
    if(isNaN(d.getTime())) return 'เลือกวันที่...';
      
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear() + 543;
      
    return `${day}/${month}/${year}`;
  }

  function formatThaiDate(dateStr) {
    if(!dateStr) return '-';
    const d = new Date(dateStr);
    if(isNaN(d.getTime())) return '-';
      
    const months = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
      
    const day = d.getDate();
    const month = months[d.getMonth()];
    const year = (d.getFullYear() + 543) % 100; 
      
    return `${day} ${month} ${year}`;
  }

  function syncDateDisplay(inputId, displayId) {
      const input = document.getElementById(inputId);
      const display = document.getElementById(displayId);
      if(input && display) {
          display.textContent = formatDateForInputBox(input.value);
      }
  }

  function updateThaiDateDisplay() {
    const workDateEl = document.getElementById('workDate');
    if (!workDateEl) return;

    const inputVal = workDateEl.value;
    const label = document.getElementById('dateLabel');

    if (inputVal) { 
        const d = new Date(inputVal);
        if(!isNaN(d.getTime())) {
            const day = d.getDay();
            const typeVal = (day===0||day===6)?'weekend':'weekday';
            const rad = document.querySelector(`input[name="type"][value="${typeVal}"]`);
            if(rad) { rad.checked=true; updateRadioStyle(); }
            
            if(label) {
                label.textContent = `วันที่: ${formatThaiDateDisplay(inputVal)}`;
                label.style.color = 'var(--brand)';
            }
        }
    }
    syncDateDisplay('workDate', 'workDateShow');
  }

  function formatTimeInput(e) {
    let v = e.target.value.replace(/[^0-9]/g, '');
    if (v.length > 4) v = v.substring(0,4);
    if (v.length > 2) e.target.value = v.substring(0,2) + ':' + v.substring(2);
    else e.target.value = v;
  }

  function validateTimeInput(e) {
    let v = e.target.value;
    if(!v.includes(':') && v.length === 4) { 
        v = v.substring(0,2) + ':' + v.substring(2); 
        e.target.value = v; 
    }
    const parts = v.split(':');
    if(parts.length === 2) {
        let h = parseInt(parts[0]);
        let m = parseInt(parts[1]);
        if (isNaN(h)) h = 0;
        if (isNaN(m)) m = 0;
        if (h > 24) h = 24;
        if (m > 59) m = 59;
        e.target.value = String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0');
    }
  }

  function getDateString(year, month, day) {
      const m = String(month).padStart(2, '0');
      const d = String(day).padStart(2, '0');
      return `${year}-${m}-${d}`;
  }

  function getPlainName(name) {
      if (!name) return "";
      return String(name).replace(/^#\d+\s+/, "").replace(/\s+/g, ' ').trim();
  }

  let currentCalcResult = null; 
  let otHistory = [];
  let rawDrivers = JSON.parse(CloudStorage.getItem('egat_drivers'));
  let drivers = [];
  let verifiedStatus = JSON.parse(CloudStorage.getItem('egat_ot_verified_status')) || {};

  if (rawDrivers && rawDrivers.length > 0) {
      if (typeof rawDrivers[0] === 'string') {
          drivers = rawDrivers.map(d => ({ id: Date.now() + Math.random(), name: d, nickname: '', phone: '', affiliation: '', department: '' }));
          CloudStorage.setItem('egat_drivers', JSON.stringify(drivers));
      } else {
          drivers = rawDrivers;
      }
  } else {
      drivers = [];
  }

  let dragStartIndex = null;

  function handleDragStart(e) {
      dragStartIndex = parseInt(this.dataset.index);
      this.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/html', this.innerHTML);
  }
  function handleDragOver(e) {
      if (e.preventDefault) e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      return false;
  }
  function handleDragEnter(e) {
      if (this !== document.querySelector('.dragging')) {
          this.classList.add('drag-over');
      }
  }
  function handleDragLeave(e) {
      this.classList.remove('drag-over');
  }
  function handleDrop(e) {
      if (e.stopPropagation) e.stopPropagation();
      const dragEndIndex = parseInt(this.dataset.index);

      if (dragStartIndex !== null && dragStartIndex !== dragEndIndex) {
          const draggedItem = drivers[dragStartIndex];
          drivers.splice(dragStartIndex, 1);
          drivers.splice(dragEndIndex, 0, draggedItem);
          
          CloudStorage.setItem('egat_drivers', JSON.stringify(drivers));

          let dSelect = document.getElementById('driverSelect');
          if (dSelect && dSelect.value) {
              let plainName = dSelect.value.replace(/^#\d+\s+/, "").trim();
              let newIndex = drivers.findIndex(d => d.name === plainName);
              if (newIndex !== -1) dSelect.value = `#${newIndex + 1} ${plainName}`;
          }
          ['daily', 'driver'].forEach(mode => {
              let f = historyFilters[mode].driver;
              if (f) {
                  let plainName = f.replace(/^#\d+\s+/, "").trim();
                  let newIndex = drivers.findIndex(d => d.name === plainName);
                  if (newIndex !== -1) historyFilters[mode].driver = `#${newIndex + 1} ${plainName}`;
              }
          });
          
          sortHistory();
          CloudStorage.setItem('egat_ot_history', JSON.stringify(otHistory));

          renderDrivers(); 
          renderHistory();
      }
      return false;
  }
  function handleDragEnd(e) {
      this.classList.remove('dragging');
      document.querySelectorAll('.driver-item-row').forEach(row => row.classList.remove('drag-over'));
      dragStartIndex = null;
  }

  let editingRowId = null;
  let showAll = false;
  let filteredIds = []; 
  try { otHistory = JSON.parse(CloudStorage.getItem('egat_ot_history')) || []; } catch(e) {}
   
  function sanitizeHistoryData() {
      if (!Array.isArray(otHistory)) return;
      let changed = false;
      otHistory.forEach(item => {
          if (!item || item.isLeave) return;
          const isBadTimeRange = !item.timeRange || item.timeRange.includes('NaN') || item.timeRange === 'undefined';
          const hasValidTimes = item.start && item.end && item.start !== '-' && item.end !== '-' && !item.start.includes('NaN') && !item.end.includes('NaN');

          if (isBadTimeRange) {
              if (hasValidTimes) {
                  item.timeRange = `${item.start} - ${item.end}`;
                  changed = true;
              } else {
                  if (item.timeRange) {
                      delete item.timeRange;
                      changed = true;
                  }
                  if (!item.isPending) {
                      item.isPending = true;
                      changed = true;
                  }
              }
          } else if (item.isTemplate || item.start === '-' || item.end === '-') {
              if (item.timeRange) {
                  delete item.timeRange;
                  changed = true;
              }
              if (!item.isPending) {
                  item.isPending = true;
                  changed = true;
              }
          }
      });
      if (changed) {
          try { CloudStorage.setItem('egat_ot_history', JSON.stringify(otHistory)); } catch(e) {}
      }
  }

  sanitizeHistoryData();
  sortHistory();

  const WORKDAY_MINUTES = 8*60;
  const LUNCH_BREAK_MIN = 60;
  const DINNER_BREAK_MIN = 30;

  // =====================================================================
// สถานะการตรวจสอบ 3 ระดับ (pending -> received -> verified)
// รองรับข้อมูลเก่าที่เก็บเป็น boolean: true = ตรวจสอบแล้ว
// =====================================================================
const ST_PENDING = 'pending';
const ST_RECEIVED = 'received';
const ST_VERIFIED = 'verified';

const ST_LABEL = {
    pending:  { icon: '⏳', text: 'รอตรวจสอบ',   cls: 'st-pending'  },
    received: { icon: '📄', text: 'ได้รับเอกสาร', cls: 'st-received' },
    verified: { icon: '✅', text: 'ตรวจสอบแล้ว',  cls: 'st-verified' }
};

// อ่านคีย์เดือนปัจจุบัน (ใช้ร่วมกันหลายฟังก์ชัน)
function currentMonthKey() {
    const input = document.getElementById('historyMonthPicker');
    if (input && input.value && /^\d{4}-\d{2}$/.test(input.value)) return input.value;
    if (typeof getGlobalSelectedMonth === 'function') return getGlobalSelectedMonth();
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// แปลงค่าเดิม (true / false / string) ให้เป็นสถานะมาตรฐาน
function normalizeStatusValue(v) {
    if (v === true) return ST_VERIFIED;
    if (v === ST_RECEIVED) return ST_RECEIVED;
    if (v === ST_VERIFIED) return ST_VERIFIED;
    return ST_PENDING;
}

// อ่านสถานะล่าสุดจาก LocalStorage เสมอ (Single Source of Truth ข้าม Role)
// คีย์: egat_ot_verified_status -> { "YYYY-MM": { "ชื่อ พขร.": "pending|received|verified" } }
function reloadVerifyStatus() {
    try {
        const raw = CloudStorage.getItem('egat_ot_verified_status');
        const parsed = raw ? JSON.parse(raw) : {};
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            verifiedStatus = parsed;
        }
    } catch(e) {}
}

function getVerifyState(driverName, monthKey) {
    reloadVerifyStatus();
    const mk = monthKey || currentMonthKey();
    const clean = getPlainName(driverName);
    if (!clean) return ST_PENDING;
    const bucket = verifiedStatus[mk];
    if (!bucket) return ST_PENDING;
    if (bucket[clean] !== undefined) return normalizeStatusValue(bucket[clean]);

    // [SYNC FIX] ตรวจจับชื่อที่มีการเคาะเว้นวรรคไม่เท่ากัน (เช่น 1 ช่อง vs 2 ช่อง)
    for (const key of Object.keys(bucket)) {
        if (getPlainName(key) === clean) {
            return normalizeStatusValue(bucket[key]);
        }
    }
    return ST_PENDING;
}

// เขียนสถานะลง verifiedStatus + localStorage (ทุกครั้ง)
// [SYNC FIX] reload ก่อนเขียน กันเขียนทับข้อมูลเดือนอื่นที่อยู่ใน storage
function setVerifyState(driverName, state, monthKey) {
    reloadVerifyStatus();
    const mk = monthKey || currentMonthKey();
    const clean = getPlainName(driverName);
    if (!clean) return false;
    if (!verifiedStatus[mk]) verifiedStatus[mk] = {};

    // ลบคีย์เดิมทั้งหมดที่ตรงกับชื่อนี้ (รวมทั้งแบบมีเว้นวรรค 2 ช่อง หรือติด #ลำดับ)
    for (const key of Object.keys(verifiedStatus[mk])) {
        if (getPlainName(key) === clean) {
            delete verifiedStatus[mk][key];
        }
    }

    if (state !== ST_PENDING) {
        verifiedStatus[mk][clean] = state;
    }

    try {
        CloudStorage.setItem('egat_ot_verified_status', JSON.stringify(verifiedStatus));
    } catch(e) {
        console.error('บันทึกสถานะไม่สำเร็จ:', e);
        return false;
    }
    return true;
}

// ปุ่มสถานะปุ่มเดียว: คลิกวนลูป pending -> received -> verified -> pending
// [SYNC FIX] รับ monthKey ตรงจากตาราง (กันอัปเดตผิดเดือนตอนดูเดือนย้อนหลัง)
// อัปเดต object หลัก -> เซฟ LocalStorage ทันที -> re-render real-time
function advanceVerifyState(driverName, monthKey) {
    // [SECURITY] เฉพาะแอดมินเท่านั้นที่เปลี่ยนสถานะได้
    if (typeof Auth !== 'undefined' && !Auth.isAdmin()) {
        alert('⛔ เฉพาะผู้ดูแลระบบเท่านั้นที่เปลี่ยนสถานะได้ครับ');
        return;
    }
    const clean = getPlainName(driverName);
    if (!clean) return;
    const mk = monthKey || currentMonthKey();
    const cur = getVerifyState(clean, mk);
    const next = (cur === ST_PENDING) ? ST_RECEIVED : (cur === ST_RECEIVED) ? ST_VERIFIED : ST_PENDING;

    if (!setVerifyState(clean, next, mk)) {
        alert('❌ บันทึกสถานะไม่สำเร็จ (พื้นที่จัดเก็บอาจเต็ม)');
        return;
    }

    renderHistory();
    try { if (typeof renderAdminDashboard === 'function') renderAdminDashboard(); } catch(e) {}
}
window.advanceVerifyState = advanceVerifyState;
window.setVerifyState = setVerifyState;
window.getVerifyState = getVerifyState;

// สร้าง HTML ของเซลล์สถานะ ตามสิทธิ์ของผู้ใช้ (ปุ่มเดียวคลิกวนลูป)
// [SYNC FIX] รับ monthKey ตรงจากตาราง — กัน พขร. ดูเดือนย้อนหลังแล้วเห็นสถานะผิดเดือน
function buildStatusCellHtml(driverName, extraHtml, monthKey) {
    const state = getVerifyState(driverName, monthKey);
    const meta = ST_LABEL[state] || ST_LABEL[ST_PENDING];
    const isAdmin = (typeof Auth !== 'undefined' && Auth.isAdmin());

    let actionHtml = '';
    if (isAdmin) {
        // แอดมิน: ปุ่มสถานะปุ่มเดียว คลิกวนลูป pending -> received -> verified -> pending
        const nextState = (state === ST_PENDING) ? ST_RECEIVED : (state === ST_RECEIVED) ? ST_VERIFIED : ST_PENDING;
        const nextMeta = ST_LABEL[nextState];

        const mkArg = monthKey ? `, '${monthKey}'` : '';
        actionHtml = `<button class="status-badge clickable ${meta.cls}" onclick="advanceVerifyState('${driverName}'${mkArg})"`
            + ` title="คลิกเพื่อเปลี่ยนเป็น &quot;${nextMeta.text}&quot;">${meta.icon} ${meta.text}</button>`;
    } else {
        // พขร./Guest: ป้าย read-only เท่านั้น กดเปลี่ยนไม่ได้
        actionHtml = `<span class="status-badge readonly ${meta.cls}">${meta.icon} ${meta.text}</span>`;
    }

    return `<div style="display:flex; flex-direction:column; gap:6px; align-items:center; width:100%; min-width:150px;">
        ${actionHtml}
        ${extraHtml || ''}
    </div>`;
}

function setVerifyStateAndRefresh(driverName, state) {
    if (typeof Auth !== 'undefined' && !Auth.isAdmin()) {
        alert('⛔ เฉพาะผู้ดูแลระบบเท่านั้นที่เปลี่ยนสถานะได้ครับ');
        return;
    }
    if (!setVerifyState(driverName, state)) {
        alert('❌ บันทึกสถานะไม่สำเร็จ');
        return;
    }
    renderHistory();
    try { if (typeof renderAdminDashboard === 'function') renderAdminDashboard(); } catch(e) {}
}
// =====================================================================
// โปรไฟล์ พขร. — ซิงค์กับฐานข้อมูลรายชื่อ พขร. หลัก
// =====================================================================
// ชื่อที่กำลังแก้ไขอยู่ (เก็บแยก ไม่ parse กลับจากข้อความบนหน้าจอ)
let profileTargetName = '';
// สถานะดู/ซ่อน PIN ในโปรไฟล์ (ประกาศไว้ก่อนใช้ กัน TDZ error)
let profilePinVisible = false;

// เปิดฟอร์มโปรไฟล์ (พขร. = ตัวเอง, แอดมิน = เลือกคนอื่นได้)
window.openProfileModal = function(editName) {
      let targetName = '';

      if (typeof Auth !== 'undefined' && Auth.isAdmin() && editName) {
          targetName = getPlainName(editName);              // แอดมินแก้ของคนอื่น
      } else {
          if (typeof Auth !== 'undefined' && !Auth.canWrite()) {
              openLoginModal('กรุณาเข้าสู่ระบบก่อนจึงจะดูและแก้ไขโปรไฟล์ได้');
              return;
          }
          targetName = Auth.currentName();                 // พขร. แก้ของตัวเอง
      }

      if (!targetName) { alert('⚠️ ไม่พบชื่อผู้ใช้'); return; }

      const rec = drivers.find(d => getPlainName(d && d.name) === targetName);
      if (!rec) {
          alert('⚠️ ไม่พบ "' + targetName + '" ในฐานข้อมูลรายชื่อ พขร.\n'
              + 'กรุณาใช้เมนู "ลงทะเบียนชื่อใหม่" เพื่อเพิ่มชื่อนี้เข้าระบบก่อน');
          return;
      }

      profileTargetName = targetName;                       // [FIX] เก็บค่าไว้ตรงๆ
      profilePinVisible = false;                            // รีเซ็ตการดู PIN ทุกครั้งที่เปิด
      refreshProfilePinDisplay();
      const sub = document.getElementById('profileSubtitle');
      if (sub) sub.textContent = (typeof Auth !== 'undefined' && Auth.isAdmin() && editName)
          ? 'กำลังแก้ไขโปรไฟล์ของ: ' + targetName
          : 'ชื่อของคุณ: ' + targetName;

      const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
      setVal('pfName', rec.name);
      setVal('pfNickname', rec.nickname);
      setVal('pfPhone', rec.phone);
      setVal('pfAffiliation', rec.affiliation);
      setVal('pfDepartment', rec.department);
      // [NEW] ล้างช่อง PIN ทุกครั้งที่เปิดฟอร์ม
      ['pfOldPin', 'pfNewPin', 'pfConfirmPin'].forEach(id => setVal(id, ''));
      const pinMsg = document.getElementById('pfPinMsg');
      if (pinMsg) pinMsg.textContent = '';

      // [FIX] ชื่อหลักห้ามแก้ — ประวัติทั้งหมดผูกกับชื่อนี้
      // ถ้าเปลี่ยนชื่อ ประวัติ OT เดิมจะกลายเป็นของคนอื่น/หายจากรายงาน
      const nameEl = document.getElementById('pfName');
      if (nameEl) {
          nameEl.disabled = true;
          nameEl.style.background = '#f1f5f9';
          nameEl.style.cursor = 'not-allowed';
          nameEl.title = 'ชื่อ-นามสกุลใช้เป็นคีย์ผูกกับประวัติ OT จึงเปลี่ยนไม่ได้';
      }

      const modal = document.getElementById('profileModal');
      if (modal) modal.classList.add('show');
  };

window.closeProfileModal = function() {
      const modal = document.getElementById('profileModal');
      if (modal) modal.classList.remove('show');
  };

// ===== รหัส PIN ปัจจุบันในโปรไฟล์: •••• / ตัวจริง / ยังไม่ตั้ง =====
function refreshProfilePinDisplay() {
      const disp = document.getElementById('pfPinDisplay');
      const notSet = document.getElementById('pfPinNotSet');
      const eye = document.getElementById('pfPinEyeBtn');
      const row = disp ? disp.parentElement : null;
      const hasPin = (typeof Auth !== 'undefined' && Auth.hasPin) ? Auth.hasPin(profileTargetName) : false;
      const isAdmin = (typeof Auth !== 'undefined' && Auth.isAdmin && Auth.isAdmin());
      const isSelf = (typeof Auth !== 'undefined' && Auth.currentName) ? (Auth.currentName() === profileTargetName) : false;
      const canView = isAdmin || isSelf;
      if (!hasPin) {
          if (disp) disp.style.display = 'none';
          if (row && eye) eye.style.display = 'none';
          if (notSet) notSet.style.display = '';
          return;
      }
      if (disp) disp.style.display = '';
      if (notSet) notSet.style.display = 'none';
      if (row && eye) eye.style.display = canView ? '' : 'none';
      if (!disp) return;
      if (profilePinVisible && canView && Auth.getDriverPin) {
          disp.textContent = Auth.getDriverPin(profileTargetName) || '••••';
      } else {
          disp.textContent = '••••';
      }
  }
window.toggleProfilePinVisibility = function() {
      profilePinVisible = !profilePinVisible;
      refreshProfilePinDisplay();
  };

// ===== Modal เปลี่ยนรหัส PIN โดยเฉพาะ (กะทัดรัด) =====
window.openPinModal = function() {
      const modal = document.getElementById('pinModal');
      if (!modal) return;
      ['pfOldPin', 'pfNewPin', 'pfConfirmPin'].forEach(id => {
          const el = document.getElementById(id);
          if (el) el.value = '';
      });
      const msg = document.getElementById('pfPinMsg');
      if (msg) { msg.textContent = ''; msg.style.color = ''; }
      modal.classList.add('show');
      const first = document.getElementById('pfOldPin');
      if (first) setTimeout(() => { try { first.focus(); } catch(e) {} }, 80);
  };
window.closePinModal = function() {
      const modal = document.getElementById('pinModal');
      if (modal) modal.classList.remove('show');
  };
// ยืนยันเปลี่ยน PIN จาก Modal (ตรวจ old/new/confirm แล้วบันทึกผ่าน Auth.adminResetPin)
// พขร. เปลี่ยนของตัวเองต้องกรอก PIN เดิม / Admin รีเซ็ตให้คนอื่นได้โดยไม่ต้องรู้ PIN เดิม
window.confirmPinChange = function() {
      const targetName = profileTargetName;
      if (!targetName) { alert('⚠️ กรุณาเปิดฟอร์มโปรไฟล์ก่อนเปลี่ยน PIN'); return; }
      const get = id => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
      const oldPin = get('pfOldPin');
      const newPin = get('pfNewPin');
      const confirmPin = get('pfConfirmPin');
      const pinMsg = document.getElementById('pfPinMsg');
      const showPinMsg = (txt, color) => {
          if (pinMsg) { pinMsg.textContent = txt; pinMsg.style.color = color; }
      };
      const isAdminReset = (typeof Auth !== 'undefined' && Auth.isAdmin() && Auth.currentName() !== targetName);
      if (isAdminReset) {
          // Admin รีเซ็ตให้คนอื่น: กรอกแค่ PIN ใหม่ 2 ช่องพอ
          if (!newPin || !confirmPin) {
              showPinMsg('⚠️ กรุณากรอก PIN ใหม่ และยืนยัน PIN ใหม่', '#b45309');
              return;
          }
          if (!/^\d{4}$/.test(newPin)) { showPinMsg('❌ PIN ใหม่ต้องเป็นตัวเลข 4 หลัก', '#b91c1c'); return; }
          if (newPin !== confirmPin) { showPinMsg('❌ PIN ใหม่กับยืนยัน PIN ไม่ตรงกัน', '#b91c1c'); return; }
      } else {
          if (!oldPin || !newPin || !confirmPin) {
              showPinMsg('⚠️ กรุณากรอก PIN เดิม, PIN ใหม่ และยืนยัน PIN ใหม่ ให้ครบทั้ง 3 ช่อง', '#b45309');
              return;
          }
          if (!/^\d{4}$/.test(oldPin)) { showPinMsg('❌ PIN เดิมต้องเป็นตัวเลข 4 หลัก', '#b91c1c'); return; }
          if (!/^\d{4}$/.test(newPin)) { showPinMsg('❌ PIN ใหม่ต้องเป็นตัวเลข 4 หลัก', '#b91c1c'); return; }
          if (newPin !== confirmPin) { showPinMsg('❌ PIN ใหม่กับยืนยัน PIN ไม่ตรงกัน', '#b91c1c'); return; }
          if (newPin === oldPin) { showPinMsg('❌ PIN ใหม่ต้องต่างจาก PIN เดิม', '#b91c1c'); return; }
          if (Auth.hasPin(targetName) && !Auth.verifyPin(targetName, oldPin)) {
              showPinMsg('❌ PIN เดิมไม่ถูกต้อง', '#b91c1c');
              return;
          }
      }
      const pinRes = Auth.adminResetPin(targetName, newPin);
      if (!pinRes.ok) { showPinMsg('❌ ' + pinRes.msg, '#b91c1c'); return; }
      showPinMsg('✅ เปลี่ยน PIN สำเร็จแล้ว', '#047857');
      profilePinVisible = false;
      try { refreshProfilePinDisplay(); } catch(e) {}
      try { renderDrivers(); } catch(e) {}
      try { if (typeof renderDriverPageList === 'function') renderDriverPageList(); } catch(e) {}
      setTimeout(() => { window.closePinModal(); }, 700);
  };

  // ===== Modal เปลี่ยนรหัส PIN ผู้ดูแลระบบ (Admin) =====
  window.openAdminPinModal = function() {
      const modal = document.getElementById('adminPinModal');
      if (modal) {
          ['adminOldPin', 'adminNewPin', 'adminConfirmPin'].forEach(id => {
              const el = document.getElementById(id);
              if (el) el.value = '';
          });
          const msg = document.getElementById('adminPinMsg');
          if (msg) msg.textContent = '';
          modal.classList.add('show');
          const first = document.getElementById('adminOldPin');
          if (first) setTimeout(() => { try { first.focus(); } catch(e) {} }, 80);
      }
  };

  window.closeAdminPinModal = function() {
      const modal = document.getElementById('adminPinModal');
      if (modal) modal.classList.remove('show');
  };

  window.confirmAdminPinChange = function() {
      const get = id => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
      const oldPin = get('adminOldPin');
      const newPin = get('adminNewPin');
      const confirmPin = get('adminConfirmPin');
      const pinMsg = document.getElementById('adminPinMsg');
      const showPinMsg = (txt, color) => {
          if (pinMsg) { pinMsg.textContent = txt; pinMsg.style.color = color; }
      };

      if (!oldPin || !newPin || !confirmPin) {
          showPinMsg('⚠️ กรุณากรอกข้อมูลให้ครบทุกช่อง', '#b45309');
          return;
      }
      if (oldPin !== getAdminPin()) {
          showPinMsg('❌ รหัส PIN ปัจจุบันไม่ถูกต้อง', '#b91c1c');
          const el = document.getElementById('adminOldPin');
          if (el) { el.value = ''; el.focus(); }
          return;
      }
      if (!/^\d{4}$/.test(newPin)) {
          showPinMsg('❌ PIN ใหม่ต้องเป็นตัวเลข 4 หลัก', '#b91c1c');
          return;
      }
      if (newPin !== confirmPin) {
          showPinMsg('❌ PIN ใหม่กับยืนยัน PIN ไม่ตรงกัน', '#b91c1c');
          return;
      }
      if (setAdminPin(newPin)) {
          showPinMsg('✅ เปลี่ยน PIN แอดมินสำเร็จแล้ว', '#047857');
          alert('✅ เปลี่ยนรหัส PIN ผู้ดูแลระบบเรียบร้อยแล้ว\nโปรดจำรหัสใหม่ (' + newPin + ') สำหรับการเข้าสู่ระบบครั้งต่อไป');
          setTimeout(() => { window.closeAdminPinModal(); }, 600);
      } else {
          showPinMsg('❌ ไม่สามารถบันทึก PIN ใหม่ได้', '#b91c1c');
      }
  };

// บันทึกโปรไฟล์ — เขียนทับรายเดิมในฐานข้อมูล พขร. (เปลี่ยน PIN ทำผ่าน Modal แยก)
window.saveProfile = function() {
      const targetName = profileTargetName;
      if (!targetName) { alert('⚠️ ไม่พบชื่อที่จะบันทึก กรุณาเปิดฟอร์มโปรไฟล์ใหม่'); return; }

      const idx = drivers.findIndex(d => getPlainName(d && d.name) === targetName);
      if (idx === -1) { alert('❌ ไม่พบรายชื่อ "' + targetName + '" ในระบบ'); return; }

      const get = id => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
      const nick = get('pfNickname');
      const phone = get('pfPhone');
      const aff = get('pfAffiliation');
      const dept = get('pfDepartment');

      drivers[idx].nickname = nick;
      drivers[idx].phone = phone;
      drivers[idx].affiliation = aff;
      drivers[idx].department = dept;
      // drivers[idx].name = ...  // เปลี่ยนชื่อไม่ได้ (ผูกกับประวัติ)

      try {
          CloudStorage.setItem('egat_drivers', JSON.stringify(drivers));
      } catch(e) {
          alert('❌ บันทึกไม่สำเร็จ (พื้นที่จัดเก็บอาจเต็ม)');
          return;
      }

      try { renderDrivers(); } catch(e) {}
      try { if (typeof renderDriverPageList === 'function') renderDriverPageList(); } catch(e) {}
      try { if (typeof renderAdminDashboard === 'function') renderAdminDashboard(); } catch(e) {}

      closeProfileModal();
      alert('✅ บันทึกโปรไฟล์เรียบร้อย\nข้อมูลถูกซิงค์กับรายชื่อ พขร. เรียบร้อยแล้ว');
  };

  window.setVerifyStateAndRefresh = setVerifyStateAndRefresh;

  // =====================================================================
  // Admin Dashboard — การ์ด KPI + ตารางสถานะ
  // =====================================================================
  const THAI_MONTHS_FULL = ['มกราคม','กุมภาพันย์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน',
      'กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];

  // [NEW] state สำหรับ Search & Filter Bar ของตาราง Admin
  let adminTableQuery = '';
  let adminTableFilter = 'all';
  window.onAdminSearchInput = function(val) {
      adminTableQuery = val || '';
      renderAdminDashboard();
      // คืน focus ให้ช่องค้นหาหลัง re-render (กันเคอร์เซอร์หลุดขณะพิมพ์)
      const inp = document.getElementById('adminSearch');
      if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
  };
  window.onAdminStatusFilterChange = function(val) {
      adminTableFilter = val || 'all';
      renderAdminDashboard();
      const sel = document.getElementById('adminStatusFilter');
      if (sel) sel.value = adminTableFilter;
  };
  window.filterAdminStatus = function(val) {
      adminTableFilter = (adminTableFilter === val) ? 'all' : (val || 'all');
      const sel = document.getElementById('adminStatusFilter');
      if (sel) sel.value = adminTableFilter;
      renderAdminDashboard();
  };

  function getActiveMonthParts() {
      const mk = getAdminMonthKey();
      const parts = mk.split('-').map(Number);
      return { year: parts[0] || new Date().getFullYear(), month: (parts[1] || 1) - 1, key: mk };
  }

  // รวบรวมยอดตามเดือนที่เลือก (แอดมินเห็นทุกคน)
  function aggregateMonthData(m) {
      const agg = {};
      otHistory.forEach(item => {
          if (!item || !item.date) return;
          const d = new Date(item.date);
          if (isNaN(d.getTime())) return;
          if (d.getMonth() !== m.month || d.getFullYear() !== m.year) return;

          const name = getPlainName(item.driver) || '(ไม่ระบุชื่อ)';
          if (!agg[name]) agg[name] = { ot15: 0, ot1: 0, ot3: 0, leave: 0, pending: 0, missing: 0 };

          if (item.isLeave) {
              agg[name].leave++;
          } else if (!item.isPending) {
              agg[name].ot15 += (Number(item.ot15) || 0);
              agg[name].ot1  += (Number(item.ot1)  || 0);
              agg[name].ot3  += (Number(item.ot3)  || 0);
          } else {
              agg[name].pending++;
          }
          // [FIX] วันลาไม่นับเป็นรายการเอกสารตกค้าง
          if (item.isIncomplete && !item.isLeave) agg[name].missing++;
      });
      return agg;
  }

  // [NEW] ซิงค์ตัวเลือกเดือนสำหรับ Admin Dashboard
  function populateAdminMonthSelect() {
      const curKey = getAdminMonthKey();
      const picker = document.getElementById('adminMonthPicker');
      const display = document.getElementById('adminMonthDisplay');
      if (picker && !picker.value) picker.value = curKey;
      if (display) display.innerText = getThaiMonthYearFull(curKey);
  }

  window.stepAdminMonth = function(delta) {
      const curKey = getGlobalSelectedMonth();
      let [y, m] = String(curKey).split('-').map(Number);
      if (!y || !m) {
          const now = new Date();
          y = now.getFullYear();
          m = now.getMonth() + 1;
      }
      m += delta;
      if (m < 1) { m = 12; y--; }
      else if (m > 12) { m = 1; y++; }
      const newKey = `${y}-${String(m).padStart(2, '0')}`;
      setGlobalSelectedMonth(newKey);
      renderAdminDashboard();
  };

  window.onAdminMonthChange = function() {
      const picker = document.getElementById('adminMonthPicker');
      if (picker && picker.value) {
          setGlobalSelectedMonth(picker.value);
      }
      renderAdminDashboard();
  };

  // [NEW] เดือนที่แอดมินเลือก (ซิงค์ตรงกับระบบกลาง)
  function getAdminMonthKey() {
      return getGlobalSelectedMonth();
  }

  function renderAdminDashboard() {
      // [SECURITY] หน้านี้มีไว้เฉพาะแอดมิน
      if (typeof Auth !== 'undefined' && !Auth.isAdmin()) { switchView('ot'); return; }

      const m0 = getActiveMonthParts();
      let monthKey = m0.key;

      const picker = document.getElementById('adminMonthPicker');
      const display = document.getElementById('adminMonthDisplay');
      if (picker) {
          picker.value = monthKey;
      }
      if (display) {
          display.innerText = getThaiMonthYearFull(monthKey);
      }

      const mparts = String(monthKey).split('-').map(Number);
      const m = { year: mparts[0] || new Date().getFullYear(), month: (mparts[1] || 1) - 1, key: monthKey };
      const label = document.getElementById('adminMonthLabel');
      if (label) label.textContent = 'เดือน ' + (THAI_MONTHS_FULL[m.month] || '-') + ' ' + (m.year + 543);

      const agg0 = aggregateMonthData(m);
      let agg = agg0;
      let names = Object.keys(agg);

      // [AUTO-TEMPLATE] เดือนที่ยังไม่มีข้อมูล -> สร้างตารางตั้งต้นอัตโนมัติทันที
      // จากผู้ใช้ที่ "อนุมัติแล้ว" (ไม่ต้องกดสร้างเอง / ไม่ต้อง confirm)
      // เก็บเป็น Anchor 1 แถว/คน/เดือน (OT 0.0 ทุกเรท, วันลา 0, สถานะ = รอตรวจสอบ)
      if (names.length === 0) {
          const approved = (drivers || []).filter(d => {
              const n = getPlainName(d && d.name);
              return !!n && (typeof Auth === 'undefined' || Auth.isApproved(n));
          });
          if (approved.length > 0) {
              const anchorDate = getDateString(m.year, m.month + 1, 1);
              approved.forEach(d => {
                  otHistory.push({
                      id: Date.now() + Math.random(),
                      date: anchorDate,
                      type: 'weekday',
                      driver: getPlainName(d.name),
                      isPending: false,
                      isTemplate: true,          // ป้ายกำกับแถวตั้งต้น
                      ot15: 0, ot1: 0, ot3: 0,
                      requestOT: 0, start: '-', end: '-'
                  });
              });
              sortHistory();
              try { CloudStorage.setItem('egat_ot_history', JSON.stringify(otHistory)); } catch(e) {}
              agg = aggregateMonthData(m);
              names = Object.keys(agg);
          }
      }

      // เรียงลำดับ พขร. ตามหมายเลขลำดับจริงในระบบ (# 1..51)
      names.sort((a, b) => {
          const indexA = (drivers || []).findIndex(d => getPlainName(d && d.name) === getPlainName(a));
          const indexB = (drivers || []).findIndex(d => getPlainName(d && d.name) === getPlainName(b));
          if (indexA === -1 && indexB === -1) return a.localeCompare(b, 'th');
          if (indexA === -1) return 1;
          if (indexB === -1) return -1;
          return indexA - indexB;
      });

      let s15 = 0, s1 = 0, s3 = 0, leaveSum = 0;
      let verifiedCnt = 0, receivedCnt = 0, stPendingCnt = 0, incompletePeople = 0;
      names.forEach(n => {
          const a = agg[n];
          s15 += a.ot15; s1 += a.ot1; s3 += a.ot3;
          leaveSum += a.leave;                                   // นับวันลาเฉพาะเดือนที่เลือก
          if (a.missing > 0) incompletePeople++;                 // คนที่แจ้งเอกสารไม่ครบในเดือนนี้
          const st = getVerifyState(n, monthKey);
          if (st === ST_VERIFIED) verifiedCnt++;
          else if (st === ST_RECEIVED) receivedCnt++;
          else stPendingCnt++;
      });
      // [FIX] คนที่ "ยังไม่ยื่น" เดือนนี้ = รายชื่อในระบบแต่ไม่มี record ในเดือนที่เลือก
      // (เดิมรวม a.pending = จำนวน "รายการ" ทำให้ตัวเลขค้างสูง เช่น 1581)
      const knownNames = new Set(names);
      let notSubmitted = 0;
      (drivers || []).forEach(d => {
          const pn = getPlainName(d && d.name);
          if (pn && !knownNames.has(pn)) notSubmitted++;
      });
      const flaggedCnt = incompletePeople + notSubmitted;

      const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
      set('kpiDrivers', String(names.length));
      set('kpiDriversSub', 'ทั้งหมด ' + (drivers || []).length + ' คนในระบบ');

      // การ์ด 1: แจ้งเตือนเมื่อมี พขร. ขาดเอกสาร หรือ ยังไม่ยื่น
      const flagCard = document.getElementById('kpiFlagCard');
      const flagText = document.getElementById('kpiPendingText');
      if (flagCard) {
          if (flaggedCnt > 0) {
              flagCard.style.display = 'block';
              const parts = [];
              if (incompletePeople > 0) parts.push('ขาดเอกสาร ' + incompletePeople + ' คน');
              if (notSubmitted > 0) parts.push('ยังไม่ยื่น ' + notSubmitted + ' คน');
              if (flagText) flagText.textContent = '⚠️ ' + parts.join(' / ');
          } else {
              flagCard.style.display = 'none';
          }
      }
      set('kpiPending', String(flaggedCnt));

      // การ์ด 2: OT Hours
      set('kpiTotalHours', ((s15 + s1 + s3) / 60).toFixed(1));
      set('kpiOt15', (s15 / 60).toFixed(1));
      set('kpiOt1', (s1 / 60).toFixed(1));
      set('kpiOt3', (s3 / 60).toFixed(1));

      // การ์ด 3: วันลา
      set('kpiLeaveDays', String(leaveSum));

      // การ์ด 4: ความคืบหน้าการอนุมัติ & Progress Bar
      const pct = names.length > 0 ? Math.round((verifiedCnt / names.length) * 100) : 0;
      set('kpiPercent', pct + '%');
      const progBar = document.getElementById('kpiProgressBar');
      if (progBar) progBar.style.width = pct + '%';

      set('kpiStPending', String(stPendingCnt));
      set('kpiStReceived', String(receivedCnt));
      set('kpiVerified', String(verifiedCnt));
      set('kpiVerifiedSub', 'อนุมัติแล้ว ' + verifiedCnt + ' / ' + names.length + ' คน (' + pct + '%)');

      // ไฮไลต์ปุ่มสถานะ chip ที่เลือกอยู่
      const curF = adminTableFilter || 'all';
      document.querySelectorAll('.kpi-chip-btn').forEach(btn => {
          btn.classList.remove('active');
          if (btn.classList.contains('chip-pending') && curF === 'pending') btn.classList.add('active');
          if (btn.classList.contains('chip-received') && curF === 'received') btn.classList.add('active');
          if (btn.classList.contains('chip-verified') && curF === 'verified') btn.classList.add('active');
      });

      const box = document.getElementById('adminStatusTable');
      if (!box) return;

      // [NEW] คงค่าช่องค้นหา/ฟิลเตอร์ไว้หลัง re-render
      const searchEl = document.getElementById('adminSearch');
      if (searchEl && searchEl.value !== adminTableQuery) searchEl.value = adminTableQuery;
      const filterEl = document.getElementById('adminStatusFilter');
      if (filterEl) filterEl.value = adminTableFilter || 'all';

      // [NEW] อัปเดตปุ่มกระดิ่งบัญชีรออนุมัติ (ซ่อนเมื่อ 0 คน)
      try { updatePendingBell(); } catch(e) { console.warn('updatePendingBell:', e); }

      if (names.length === 0) {
          box.innerHTML = '<div style="text-align:center; padding:40px 20px; color:#94a3b8;">ยังไม่มีข้อมูลในเดือนนี้</div>';
          return;
      }
      // [NEW] กรองตามช่องค้นหา + dropdown/chip สถานะ (Search & Filter Bar)
      const q = (adminTableQuery || '').trim().toLowerCase();
      const f = adminTableFilter || 'all';
      const shown = names.filter(n => {
          const rec = (drivers || []).find(d => getPlainName(d && d.name) === getPlainName(n));
          const nick = rec && rec.nickname ? String(rec.nickname).toLowerCase() : '';
          if (q && n.toLowerCase().indexOf(q) === -1 && nick.indexOf(q) === -1) return false;
          if (f === 'all') return true;
          const a = agg[n];
          if (f === 'incomplete') return a && a.missing > 0;
          if (f === 'leave') return a && a.leave > 0;
          const st = getVerifyState(n, monthKey);
          if (f === 'pending') return st === ST_PENDING;
          if (f === 'received') return st === ST_RECEIVED;
          if (f === 'verified') return st === ST_VERIFIED;
          return true;
      });
      if (shown.length === 0) {
          box.innerHTML = '<div style="text-align:center; padding:40px 20px; color:#94a3b8;">🔍 ไม่พบข้อมูลที่ตรงกับเงื่อนไขค้นหา</div>';
          return;
      }
      const statusData = buildAdminStatusRows(shown, agg, monthKey);

      box.innerHTML = '<div class="table-container"><table class="history-table"><thead><tr>'
          + '<th class="col-center" style="width:50px;">#</th>'
          + '<th style="text-align:left;">👤 ชื่อ พขร.</th>'
          + '<th class="col-center th-ot" style="background:#eff6ff; color:#1e3a8a;">X1.5</th>'
          + '<th class="col-center th-ot" style="background:#ecfeff; color:#0e7490;">X1</th>'
          + '<th class="col-center th-ot" style="background:#fff1f2; color:#be123c;">X3</th>'
          + '<th class="col-center th-ot">⏱️ รวม (ชม.)</th>'
          + '<th class="col-center" style="width:60px;">🏖️ ลา</th>'
          + '<th class="col-center">🛡️ สถานะ / การจัดการ</th>'
          + '</tr></thead>'
          + '<tbody>' + statusData.rows + '</tbody>'
          + '<tfoot>'
          + '<tr class="admin-total-row" style="background:linear-gradient(to right, #f8fafc, #f1f5f9); font-weight:800; border-top:2px solid #cbd5e1; border-bottom:2px solid #cbd5e1;">'
          +   '<td class="col-center" colspan="2" style="text-align:right; padding-right:14px; color:var(--brand); font-size:0.95rem;">📊 รวมทั้งหมด (' + statusData.totals.count + ' คน):</td>'
          +   '<td class="col-center num-cell" style="color:#1e3a8a; font-weight:800;">' + statusData.totals.tot15 + '</td>'
          +   '<td class="col-center num-cell" style="color:#0e7490; font-weight:800;">' + statusData.totals.tot1 + '</td>'
          +   '<td class="col-center num-cell" style="color:#be123c; font-weight:800;">' + statusData.totals.tot3 + '</td>'
          +   '<td class="col-center num-cell" style="color:var(--brand); font-size:1.05rem; font-weight:900;">' + statusData.totals.totalHours + '</td>'
          +   '<td class="col-center num-cell" style="color:#ef4444; font-weight:800;">' + statusData.totals.totLeave + '</td>'
          +   '<td class="col-center" style="font-size:0.85rem; color:#047857; font-weight:700;">✅ อนุมัติแล้ว ' + statusData.totals.verified + ' / ' + statusData.totals.count + ' คน</td>'
          + '</tr>'
          + '</tfoot>'
          + '</table></div>';

      try { applyMobileCardLabels(document.querySelector('#adminStatusTable .history-table')); } catch(e) {}
  }
  window.renderAdminDashboard = renderAdminDashboard;

  // ---------- บัญชีรออนุมัติ: ปุ่มกระดิ่ง + Modal (แทน Banner เดิม) ----------
  // ปุ่มซ่อนเมื่อ 0 คน / โชว์พร้อม badge จำนวนเมื่อมีคนรอ
  function updatePendingBell() {
      const btn = document.getElementById('pendingBellBtn');
      const badge = document.getElementById('pendingCountBadge');
      if (!btn) return;
      let count = 0;
      try { count = (typeof Auth !== 'undefined' && Auth.getPendingList) ? Auth.getPendingList().length : 0; } catch(e) { count = 0; }
      if (badge) badge.textContent = String(count);
      btn.style.display = count > 0 ? '' : 'none';
  }
  window.updatePendingBell = updatePendingBell;

  function renderApprovalModalList() {
      const list = document.getElementById('approvalModalList');
      if (!list) return;
      let pending = [];
      try { pending = (typeof Auth !== 'undefined' && Auth.getPendingList) ? Auth.getPendingList() : []; } catch(e) { pending = []; }
      if (!pending || pending.length === 0) {
          list.innerHTML = '<div class="approval-done">✅ อนุมัติครบเรียบร้อยแล้ว ไม่มีบัญชีรอการอนุมัติ</div>';
          return;
      }
      list.innerHTML = pending.map(p => {
          const rec = (typeof drivers !== 'undefined' ? drivers : []).find(d => getPlainName(d && d.name) === p.name) || {};
          const rows = [
              rec.nickname ? '<div>ชื่อเล่น: <b>' + rec.nickname + '</b></div>' : '',
              rec.phone ? '<div>โทร: <b>' + rec.phone + '</b></div>' : '',
              (rec.department || rec.affiliation) ? '<div>แผนก/สังกัด: <b>' + [rec.department, rec.affiliation].filter(Boolean).join(' / ') + '</b></div>' : '',
              p.at ? '<div>ลงทะเบียน: ' + formatThaiDateOnly(p.at) + '</div>' : ''
          ].filter(Boolean).join('');
          return '<div class="pending-item">'
              +   '<div class="pending-info">'
              +     '<div class="pending-name">👤 ' + p.name + '</div>'
              +     '<div class="pending-meta">' + (rows || 'ไม่มีข้อมูลเพิ่มเติม') + '</div>'
              +   '</div>'
              +   '<div class="pending-actions">'
              +     '<button class="appr-btn ok" onclick="approveDriverAccount(\'' + p.name + '\')">✅ อนุมัติ</button>'
              +     '<button class="appr-btn no" onclick="rejectDriverAccount(\'' + p.name + '\')">❌ ปฏิเสธ</button>'
              +   '</div>'
              + '</div>';
      }).join('');
  }
  window.openApprovalModal = function() {
      renderApprovalModalList();
      const modal = document.getElementById('approvalModal');
      if (modal) modal.classList.add('show');
  };
  window.closeApprovalModal = function() {
      const modal = document.getElementById('approvalModal');
      if (modal) modal.classList.remove('show');
  };
  // คงชื่อฟังก์ชันเดิมไว้กันโค้ดอื่นเรียกพลาด -> แปลงเป็นการอัปเดต bell
  function renderPendingApprovals() { updatePendingBell(); }

  function formatThaiDateOnly(iso) {
      try {
          const d = new Date(iso);
          if (isNaN(d.getTime())) return '';
          return d.getDate() + '/' + (d.getMonth() + 1) + '/' + (d.getFullYear() + 543);
      } catch(e) { return ''; }
  }

  window.approveDriverAccount = function(name) {
      if (typeof Auth !== 'undefined' && !Auth.isAdmin()) { alert('เฉพาะผู้ดูแลระบบเท่านั้น'); return; }
      if (!confirm('อนุมัติบัญชี "' + name + '" ให้เข้าสู่ระบบได้ใช่หรือไม่?')) return;
      const res = Auth.approveAccount(name);
      if (!res.ok) { alert('❌ ' + res.msg); return; }
      // [NEW] ซิงค์ครบทุกระบบ: bell + modal + dashboard + รายชื่อ (real-time ไม่ต้องรีเฟรช)
      updatePendingBell();
      renderApprovalModalList();
      if (typeof renderAdminDashboard === 'function') renderAdminDashboard();
      if (typeof renderDriverPageList === 'function') renderDriverPageList();
      let left = 0;
      try { left = Auth.getPendingList().length; } catch(e) { left = 0; }
      if (left === 0) {
          try { window.closeApprovalModal(); } catch(e) {}
      }
      alert('✅ ' + res.msg + '\nผู้ใช้สามารถเข้าสู่ระบบได้แล้ว');
  };

  window.rejectDriverAccount = function(name) {
      if (typeof Auth !== 'undefined' && !Auth.isAdmin()) { alert('เฉพาะผู้ดูแลระบบเท่านั้น'); return; }
      if (!confirm('ปฏิเสธและลบบัญชี "' + name + '"?\nระบบจะลบบัญชีนี้ออกจากรายชื่อ พขร. ด้วย')) return;
      const res = Auth.rejectAccount(name);
      if (!res.ok) { alert('❌ ' + res.msg); return; }

      // [FIX] ลบชื่อออกจากรายชื่อหลักด้วย ไม่งั้นชื่อค้างอยู่ในระบบทั้งที่บัญชีถูกปฏิเสธแล้ว
      try {
          const idx = drivers.findIndex(d => getPlainName(d && d.name) === getPlainName(name));
          if (idx !== -1) {
              drivers.splice(idx, 1);
              CloudStorage.setItem('egat_drivers', JSON.stringify(drivers));
              renderDrivers();
          }
      } catch(e) {}

      // [NEW] ซิงค์ครบทุกระบบ real-time + ปิด modal เมื่อหมดคิว
      updatePendingBell();
      renderApprovalModalList();
      if (typeof renderAdminDashboard === 'function') renderAdminDashboard();
      if (typeof renderDriverPageList === 'function') renderDriverPageList();
      try { if (Auth.getPendingList().length === 0) window.closeApprovalModal(); } catch(e) {}
      alert('🚫 ' + res.msg);
  };

  // ---------- แอดมินตั้ง/รีเซ็ต PIN ให้ พขร. (ผ่านหน้าโปรไฟล์เท่านั้น ยกเลิก prompt) ----------
  // [NEW] สลับดู/ซ่อนรหัส PIN 4 หลักจริง
  window.toggleDriverPinVisibility = function(name) {
      window.__pinVisible = window.__pinVisible || {};
      const clean = getPlainName(name);
      window.__pinVisible[clean] = !window.__pinVisible[clean];
      try { if (typeof renderDriverPageList === 'function') renderDriverPageList(); } catch(e) {}
  };
  window.adminResetDriverPin = function(name) {
      if (typeof Auth !== 'undefined' && !Auth.isAdmin()) { alert('เฉพาะผู้ดูแลระบบเท่านั้น'); return; }
      const clean = getPlainName(name);
      if (!clean) { alert('กรุณาเลือกชื่อ พขร.'); return; }
      // เปิดหน้าโปรไฟล์แล้วเด้งฟอร์ม PIN โดยเฉพาะ (ไม่ใช้ window.prompt)
      try { openProfileModal(clean); } catch(e) {}
      setTimeout(() => { try { openPinModal(); } catch(e) {} }, 150);
  };

  // สร้างแถวตารางสถานะของหน้า Admin (ปุ่มเดียวคลิกวนลูป + ซิงค์ real-time) พร้อมคำนวณผลรวม
  function buildAdminStatusRows(names, agg, monthKey) {
      let tot15 = 0, tot1 = 0, tot3 = 0, totLeave = 0;
      let totVerified = 0, totReceived = 0, totPending = 0;

      const rowsHtml = names.map(name => {
          const a = agg[name] || { ot15: 0, ot1: 0, ot3: 0, leave: 0, missing: 0 };
          const state = getVerifyState(name, monthKey);
          const meta = ST_LABEL[state] || ST_LABEL[ST_PENDING];
          const nextState = (state === ST_PENDING) ? ST_RECEIVED : (state === ST_RECEIVED) ? ST_VERIFIED : ST_PENDING;
          const nextMeta = ST_LABEL[nextState];
          const total = (a.ot15 + a.ot1 + a.ot3) / 60;

          tot15 += a.ot15;
          tot1 += a.ot1;
          tot3 += a.ot3;
          totLeave += a.leave;
          if (state === ST_VERIFIED) totVerified++;
          else if (state === ST_RECEIVED) totReceived++;
          else totPending++;

          // ดึงลำดับจริงของ พขร. ในระบบ (# 1..51)
          const realIndex = (typeof drivers !== 'undefined' ? drivers.findIndex(d => getPlainName(d && d.name) === getPlainName(name)) : -1) + 1;
          const displayIndex = realIndex > 0 ? realIndex : '-';

          const warn = a.missing > 0
              ? `<button class="miss-btn" onclick="viewDriverMissing('${name}', '${monthKey}')" title="คลิกดูรายการที่เอกสารยังไม่ครบ">⚠️ ขาด ${a.missing}</button>`
              : '';

          const isVerified = (state === ST_VERIFIED);
          const rowClass = isVerified ? 'verified-row' : (a.missing > 0 ? 'warning-row' : '');

          const [mY, mM] = String(monthKey || '').split('-').map(Number);
          const yearArg = mY || 'null';
          const monthArg = mM || 'null';
          const safeName = String(name).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

          return '<tr class="' + rowClass + '">'
              + '<td class="col-center" style="font-weight:700; color:#94a3b8; width:50px;">' + displayIndex + '</td>'
              + '<td style="font-weight:700; color:var(--brand); text-align:left; cursor:pointer;" onclick="openQuickSummaryModal(\'' + safeName + '\', ' + yearArg + ', ' + monthArg + ')" title="คลิกดูประวัติรายวันของ ' + safeName + '">' + name + '</td>'
              + '<td class="col-center num-cell">' + (a.ot15/60).toFixed(1) + '</td>'
              + '<td class="col-center num-cell">' + (a.ot1/60).toFixed(1) + '</td>'
              + '<td class="col-center num-cell">' + (a.ot3/60).toFixed(1) + '</td>'
              + '<td class="col-center num-cell" style="font-weight:800;">' + total.toFixed(1) + '</td>'
              + '<td class="col-center num-cell" style="color:' + (a.leave > 0 ? '#ef4444' : '') + '; font-weight:' + (a.leave > 0 ? '700' : '') + ';">' + a.leave + '</td>'
              + '<td class="col-center"><div style="display:flex; flex-direction:column; gap:6px; align-items:center;">'
              +   '<button class="status-badge clickable ' + meta.cls + '" onclick="advanceVerifyState(\'' + name + '\', \'' + monthKey + '\')"'
              +     ' title="คลิกเพื่อเปลี่ยนเป็น ' + nextMeta.text + '">'
              +     meta.icon + ' ' + meta.text + '</button>'
              +   warn
              + '</div></td>'
              + '</tr>';
      }).join('');

      const totalAllHours = ((tot15 + tot1 + tot3) / 60).toFixed(1);

      return {
          rows: rowsHtml,
          totals: {
              tot15: (tot15 / 60).toFixed(1),
              tot1: (tot1 / 60).toFixed(1),
              tot3: (tot3 / 60).toFixed(1),
              totalHours: totalAllHours,
              totLeave: totLeave,
              verified: totVerified,
              received: totReceived,
              pending: totPending,
              count: names.length
          }
      };
  }

  // ปุ่มด่วนในหน้า Admin
  function adminOnly(fn) {
      if (typeof Auth !== 'undefined' && !Auth.isAdmin()) { alert('เฉพาะผู้ดูแลระบบเท่านั้น'); return; }
      fn();
  }

  window.adminGoExport = function() {
      adminOnly(function() {
          switchView('history');
          setHistoryMode('driver');
          setTimeout(function() {
              try { exportSummaryToCSV(); }
              catch(e) { alert('ส่งออกไม่สำเร็จ: ' + e.message); }
          }, 300);
      });
  };

  window.adminGoDrivers = function() {
      adminOnly(function() { switchView('drivers'); });
  };

  window.adminGoBackup = function() {
      adminOnly(function() { openBackupModal(); });
  };

  // ฟังก์ชันเดิม (ปุ่มในแถบเครื่องมือ) — ปรับให้ใช้สถานะ 3 ระดับ
function toggleVerification(driverName) {
      if(!driverName) return;
      if (typeof Auth !== 'undefined' && !Auth.isAdmin()) {
          alert('⛔ เฉพาะผู้ดูแลระบบเท่านั้นที่เปลี่ยนสถานะได้ครับ');
          return;
      }
      advanceVerifyState(driverName);
  }
  window.toggleVerification = toggleVerification;

  function toggleVerifyCurrentDriver() {
      if (typeof Auth !== 'undefined' && !Auth.isAdmin()) {
          const myName = Auth.currentName();
          const hpVal = document.getElementById('historyMonthPicker') ? document.getElementById('historyMonthPicker').value : '';
          const mk = hpVal || '';
          const st = getVerifyState(myName, mk);
          const meta = ST_LABEL[st] || ST_LABEL[ST_PENDING];
          alert(`📋 สถานะรายงานเดือนนี้ของคุณคือ: "${meta.text}"\n(การตรวจสอบและเปลี่ยนสถานะดำเนินการโดยผู้ดูแลระบบครับ)`);
          return;
      }
      const currentDriver = document.getElementById('historyDriverFilter').value;
      if(!currentDriver) {
          alert('⚠️ กรุณาเลือก "ชื่อ พขร." ที่ช่องค้นหา (👀) ด้านบนก่อน\nจึงจะสามารถกดยืนยันการตรวจสอบแบบรายบุคคลได้ครับ');
          return;
      }
      
      let plainName = getPlainName(currentDriver);
      const hpVal = document.getElementById('historyMonthPicker') ? document.getElementById('historyMonthPicker').value : '';
      if (hpVal && typeof advanceVerifyState === 'function') {
          advanceVerifyState(plainName, hpVal);
      } else {
          toggleVerification(plainName);
      }
  }

  function switchView(viewId) {
    // [SECURITY] กันการเข้าหน้าที่ไม่มีสิทธิ์ผ่าน console
    if (viewId === 'admin' && !(typeof Auth !== 'undefined' && Auth.isAdmin())) {
      alert('⛔ หน้า Admin Dashboard ใช้ได้เฉพาะผู้ดูแลระบบเท่านั้น');
      viewId = 'ot';
    }
    if (viewId === 'history' && typeof Auth !== 'undefined' && Auth.isGuest()) {
      alert('⛔ กรุณาเข้าสู่ระบบก่อนจึงจะดูสรุปรายเดือนได้');
      viewId = 'ot';
    }

    document.querySelectorAll('.menu-item').forEach(el => el.classList.remove('active'));
    
    if(viewId === 'ot') document.querySelector('.menu-item[onclick*="ot"]').classList.add('active');
    if(viewId === 'drivers') document.querySelector('.menu-item[onclick*="drivers"]').classList.add('active');
    if(viewId === 'calc') document.querySelector('.menu-item[onclick*="calc"]').classList.add('active');
    if(viewId === 'admin') {
      const adminItem = document.getElementById('menuAdmin');
      if (adminItem) adminItem.classList.add('active');
    }
    
    if(viewId === 'history') {
        const historyItem = document.getElementById('menuHistory') || document.querySelector('.menu-item[onclick*="history"]');
        if(historyItem) historyItem.classList.add('active');
    }

    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-' + viewId).classList.add('active');
      
    if(viewId === 'history') {
        showAll = false;
        // [SYNC] ถ้าในหน้าคำนวณ OT มีการเลือกวันที่ไว้ ให้ซิงค์สรุปรายเดือนตามวันที่นั้น
        const wDate = getWorkDateSelectedMonth();
        if (wDate) {
            const mk = `${wDate.year}-${String(wDate.month).padStart(2, '0')}`;
            setGlobalSelectedMonth(mk);
        }
        const currentMonth = getGlobalSelectedMonth();
        const monthPicker = document.getElementById('historyMonthPicker');
        if (monthPicker) monthPicker.value = currentMonth;
        const histDisplay = document.getElementById('historyDateDisplay');
        if (histDisplay && typeof getThaiMonthYearFull === 'function') {
            histDisplay.innerText = getThaiMonthYearFull(currentMonth);
        }
        setHistoryMode(currentHistoryMode);
        
        const toolbar = document.getElementById('historyToolbar');
        if(toolbar) {
            toolbar.style.display = currentHistoryMode === 'daily' ? 'flex' : 'none'; 
        }
    }
    if(viewId === 'drivers') {
        renderDriverPageList();
    }
    // [NEW] หน้า Admin Dashboard — ซิงค์เดือนและคำนวณ KPI ใหม่ทุกครั้งที่เปิด
    if(viewId === 'admin') {
        const currentMonth = getGlobalSelectedMonth();
        const adminPicker = document.getElementById('adminMonthPicker');
        if (adminPicker) adminPicker.value = currentMonth;
        const adminDisplay = document.getElementById('adminMonthDisplay');
        if (adminDisplay && typeof getThaiMonthYearFull === 'function') {
            adminDisplay.innerText = getThaiMonthYearFull(currentMonth);
        }
        try { renderAdminDashboard(); } catch(e) { console.warn('renderAdminDashboard:', e); }
    }
  }

  function updateBadge() {
    const badge = document.getElementById('historyCount');
    if (!badge) return;
    badge.style.display = 'none';
  }

function renderDrivers() {
  const driverList = document.getElementById('driverList');
  if (driverList) {
      driverList.innerHTML = ''; 
      drivers.forEach((d, index) => { 
        const opt = document.createElement('option');
        opt.value = `#${index + 1} ${d.name}`; 
        driverList.appendChild(opt);
      });
  }

  const historyDriverList = document.getElementById('historyDriverList'); 
  const historyDriverInput = document.getElementById('historyDriverFilter');
   
  if (historyDriverList) {
    historyDriverList.innerHTML = ''; 
    drivers.forEach((d, index) => {
      const opt = document.createElement('option');
      opt.value = `#${index + 1} ${d.name}`;
      historyDriverList.appendChild(opt);
    });

    if (historyDriverInput) {
        if(historyFilters[currentHistoryMode].driver) {
           historyDriverInput.value = historyFilters[currentHistoryMode].driver;
        } else {
           historyDriverInput.value = "";
        }
    }
  }

  renderDriverPageList();
}

  function renderDriverPageList() {
      const container = document.getElementById('driverListContainer');
      if(!container) return;
      
      container.className = 'driver-list-container';
      
      if(drivers.length === 0) {
          container.innerHTML = '<div style="padding:60px; text-align:center; color:#94a3b8;">ยังไม่มีรายชื่อ พขร. <br>กดปุ่ม "+ เพิ่มคนใหม่" ด้านบนได้เลยค่ะ</div>';
          return;
      }
      container.innerHTML = '';
      drivers.forEach((d, index) => {
          const item = document.createElement('div');
          item.className = 'driver-item-row';
          item.draggable = true;
          item.dataset.index = index;
          
          let detailsHtml = '';
          if(d.phone) detailsHtml += `<span>📞 ${d.phone}</span>`;
          if(d.affiliation || d.department) detailsHtml += `<span>🏢 ${d.affiliation} ${d.department}</span>`;
          if(detailsHtml === '') detailsHtml = '<span style="opacity:0.4;">- ไม่มีข้อมูลเพิ่มเติม -</span>';

          const pinSet = (typeof Auth !== 'undefined' && Auth.hasPin) ? Auth.hasPin(d.name) : false;
          const pinBadge = pinSet
              ? '<span class="acct-badge acct-ok">🔑 ตั้ง PIN แล้ว</span>'
              : '<span class="acct-badge acct-none">ยังไม่ตั้ง PIN</span>';

          item.innerHTML = `
            <div class="drag-handle" title="คลิกค้างเพื่อลากเลื่อนลำดับ">⠿</div>
            <div class="d-index">${index + 1}</div>
            <div class="d-info">
                <div class="d-main">${d.name} ${pinBadge}</div>
                <div class="d-sub">${detailsHtml}</div>
            </div>
            <div class="d-actions">
                <button onclick="openProfileModal('${d.name}')" class="action-btn-pill btn-edit-pill" title="ดู/แก้ไขโปรไฟล์ + จัดการ PIN">👤 โปรไฟล์ / แก้ไข</button>
                <button onclick="removeDriverByName('${d.name}')" class="action-btn-pill btn-del-pill">🗑️ ลบ</button>
            </div>
          `;
          
          item.addEventListener('dragstart', handleDragStart);
          item.addEventListener('dragover', handleDragOver);
          item.addEventListener('dragenter', handleDragEnter);
          item.addEventListener('dragleave', handleDragLeave);
          item.addEventListener('drop', handleDrop);
          item.addEventListener('dragend', handleDragEnd);

          container.appendChild(item);
      });
  }

  window.removeDriverRowAndData = function(name) {
      if (!name) return;
      if (!confirm(`ต้องการลบรายชื่อ "${name}" และเคลียร์ประวัติทำ OT ทั้งหมดออกจากระบบ (รวมถึงบนฐานข้อมูล Google คลาวด์) ใช่หรือไม่?`)) return;

      drivers = drivers.filter(d => d.name !== name);
      CloudStorage.setItem('egat_drivers', JSON.stringify(drivers));

      otHistory = otHistory.filter(item => getPlainName(item.driver) !== name);
      CloudStorage.setItem('egat_ot_history', JSON.stringify(otHistory));

      try { reloadVerifyStatus(); } catch(e) {}
      for (const monthKey in verifiedStatus) {
          if (verifiedStatus[monthKey][name] !== undefined) {
              delete verifiedStatus[monthKey][name];
          }
      }
      CloudStorage.setItem('egat_ot_verified_status', JSON.stringify(verifiedStatus));

      renderDrivers();
      renderHistory();
      updateBadge();
      alert(`🗑️ ระบบทำการลบข้อมูลทั้งหมดของ "${name}" ออกจาก Google Sheets และตัวแอปเรียบร้อยแล้วครับ`);
  };

  function openAddDriverModal() {
      document.getElementById('editDriverId').value = '';
      document.getElementById('driverModalTitle').innerText = '➕ เพิ่ม พขร. ใหม่เข้าสู่ระบบ';
      document.getElementById('dName').value = '';
      document.getElementById('dNick').value = '';
      document.getElementById('dPhone').value = '';
      document.getElementById('dAff').value = '';
      document.getElementById('dDept').value = '';
      const pinEl = document.getElementById('dPin');
      if (pinEl) pinEl.value = '';
      document.getElementById('addDriverModal').classList.add('show');
      document.getElementById('dName').focus();
  }
    
  function editDriver(id) {
      const d = drivers.find(drv => drv.id.toString() === id.toString());
      if(!d) return;
      document.getElementById('editDriverId').value = d.id;
      document.getElementById('driverModalTitle').innerText = 'แก้ไขข้อมูล พขร.';
      document.getElementById('dName').value = d.name;
      document.getElementById('dNick').value = d.nickname || '';
      document.getElementById('dPhone').value = d.phone || '';
      document.getElementById('dAff').value = d.affiliation || '';
      document.getElementById('dDept').value = d.department || '';
      document.getElementById('addDriverModal').classList.add('show');
  }
    
  function closeAddDriverModal() {
      document.getElementById('addDriverModal').classList.remove('show');
  }

  function saveDriver() {
      const id = document.getElementById('editDriverId').value;
      const nameInp = document.getElementById('dName');
      const nickInp = document.getElementById('dNick');
      const phoneInp = document.getElementById('dPhone');
      const affInp = document.getElementById('dAff');
      const deptInp = document.getElementById('dDept');
      const pinInp = document.getElementById('dPin');

      const newName = nameInp.value.trim();
      if(!newName) { alert('❌ กรุณาระบุชื่อ-นามสกุล'); return; }

      const isDuplicate = drivers.some(d => d.name === newName && d.id.toString() !== id);
      if(isDuplicate) { alert('❌ มีชื่อนี้อยู่แล้ว'); return; }

      // โหมดเพิ่มใหม่: บังคับ PIN 4 หลัก + อนุมัติทันที (Admin เพิ่มเอง)
      if(!id) {
          const pinVal = pinInp ? String(pinInp.value || '').trim() : '';
          if (!/^\d{4}$/.test(pinVal)) {
              alert('❌ กรุณาตั้งรหัส PIN 4 หลัก (ตัวเลข) ให้ พขร. ใหม่ด้วยครับ');
              if (pinInp) pinInp.focus();
              return;
          }
          const newDriver = {
              id: Date.now(),
              name: newName,
              nickname: nickInp.value.trim(),
              phone: phoneInp.value.trim(),
              affiliation: affInp.value.trim(),
              department: deptInp.value.trim()
          };
          drivers.push(newDriver);
          CloudStorage.setItem('egat_drivers', JSON.stringify(drivers));
          // ผูก PIN + อนุมัติทันที (ไม่ต้องรอ)
          try {
              const claim = Auth.claimAccount(newName, pinVal, pinVal);
              if (!claim.ok) { alert('⚠️ เพิ่มรายชื่อแล้ว แต่ผูก PIN ไม่สำเร็จ:\n' + claim.msg); }
              else Auth.approveAccount(newName);
          } catch(e) {}
          renderDrivers();
          renderHistory();
          try { if (typeof renderDriverPageList === 'function') renderDriverPageList(); } catch(e) {}
          try { if (typeof renderAdminDashboard === 'function') renderAdminDashboard(); } catch(e) {}
          closeAddDriverModal();
          alert('✅ เพิ่ม พขร. "' + newName + '" เรียบร้อย (อนุมัติใช้งานทันที)');
          nameInp.value = ''; nickInp.value = ''; phoneInp.value = ''; affInp.value = ''; deptInp.value = '';
          if (pinInp) pinInp.value = '';
          return;
      }
      // โหมดแก้ไข (เหลือไว้เผื่อเรียกจากโค้ดเก่า — ปกติใช้โปรไฟล์แทน)
      const index = drivers.findIndex(d => d.id.toString() === id);
          if(index !== -1) {
              const oldName = drivers[index].name;

              drivers[index].name = newName;
              drivers[index].nickname = nickInp.value.trim();
              drivers[index].phone = phoneInp.value.trim();
              drivers[index].affiliation = affInp.value.trim();
              drivers[index].department = deptInp.value.trim();

              if (oldName !== newName) {
                  let historyChanged = false;
                  
                  otHistory.forEach(item => {
                      if (getPlainName(item.driver) === oldName) {
                          item.driver = newName;
                          historyChanged = true;
                      }
                  });

                  let statusChanged = false;
                  try { reloadVerifyStatus(); } catch(e) {}
                  for (const monthKey in verifiedStatus) {
                      if (verifiedStatus[monthKey][oldName] !== undefined) {
                          verifiedStatus[monthKey][newName] = verifiedStatus[monthKey][oldName];
                          delete verifiedStatus[monthKey][oldName];
                          statusChanged = true;
                      }
                  }

                  if (historyChanged) {
                      CloudStorage.setItem('egat_ot_history', JSON.stringify(otHistory));
                  }
                  if (statusChanged) {
                      CloudStorage.setItem('egat_ot_verified_status', JSON.stringify(verifiedStatus));
                  }
              }
          }
      CloudStorage.setItem('egat_drivers', JSON.stringify(drivers));
      renderDrivers();
      renderHistory();
      closeAddDriverModal();
      
      nameInp.value = ''; nickInp.value = ''; phoneInp.value = ''; affInp.value = ''; deptInp.value = '';
      if (pinInp) pinInp.value = '';
  }
    
  function removeDriverByName(name) {
      if(confirm('ยืนยันลบรายชื่อ "' + name + '" ?')) {
          drivers = drivers.filter(d => d.name !== name);
          CloudStorage.setItem('egat_drivers', JSON.stringify(drivers));
          renderDrivers();
      }
  }

  const MIN = (h,m)=>h*60+m;
  const toMinutes = t => {
      if(!t || typeof t !== 'string' || t.trim() === '-' || t.trim() === '') return NaN;
      const parts = t.trim().split(':');
      if(parts.length < 2) return NaN;
      const h = Number(parts[0]);
      const m = Number(parts[1]);
      if(!isFinite(h) || !isFinite(m)) return NaN;
      return h*60+m;
  };
    
  function getEffectiveDriver() {
      const historyView = document.getElementById('view-history');
      const driverSelect = document.getElementById('driverSelect');
      const historyFilter = document.getElementById('historyDriverFilter');
      if (historyView && historyView.classList.contains('active')) {
          if (historyFilter && historyFilter.value !== "") {
              return historyFilter.value;
          }
      }
      return driverSelect ? driverSelect.value : "";
  }

  const fmt = mins => {
      const h = Math.floor(mins/60);
      const m = mins%60;
      return m > 0 ? `${h} ชม. ${m} น.` : `${h} ชม.`;
  };
    
  const fmtShort = mins => {
      if(!mins || mins===0) return '-';
      return (Math.round((mins/60) * 10) / 10).toString().replace('.0',''); 
  };

  // [FIX] ตัวเลขสำหรับ "ตารางสรุปรายเดือน" — ค่าว่าง/ศูนย์ต้องแสดงเป็น 0 ไม่ใช่ dash
  // เหตุผล: dash ทำให้ Excel อ่านเป็นค่าว่าง (text) แล้วรวมยอดไม่ได้
  // ต้องคืน "ตัวเลข" เสมอ ไม่ใช่ string ว่าง เพื่อให้นำไป SUM ใน Excel ได้
  const fmtNum = mins => {
      const num = Number(mins);
      if (!isFinite(num)) return '0';
      const hours = Math.round((num / 60) * 10) / 10;
      if (!isFinite(hours)) return '0';
      return hours.toFixed(1);   // แสดงทศนิยม 1 ตำแหน่งเสมอ เช่น 0.0, 3.5
  };

  // [FIX] "ขอเบิก OT" เก็บเป็นชั่วโมงอยู่แล้ว จึงห้ามหารด้วย 60 ซ้ำ
  // (เดิมใช้ fmtNumTrim ซึ่งคำนวณจากนาที ทำให้ 12.5 ชม. แสดงเป็น 0.2)
  const fmtHours = hours => {
      const num = Number(hours);
      if (!isFinite(num)) return '0';
      const v = Math.round(num * 10) / 10;
      if (!isFinite(v)) return '0';
      return v.toString().replace(/\.0$/, '');
  };

  const fmtTime = mins => {
      const num = Number(mins);
      if(!isFinite(num)) return '--:--';
      const h = Math.floor(num/60)%24;
      const m = num%60;
      return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
  };

  window.handleAutoPilotOT = function(reqHoursStr) {
      if (!currentCalcResult) return;
      let reqHours = parseFloat(reqHoursStr);
      if (isNaN(reqHours) || reqHours < 0) reqHours = 0;

      let reqMins = Math.round(reqHours * 60);
      let max15 = currentCalcResult.baseOt15 || 0;
      let max1  = currentCalcResult.baseOt1 || 0;
      let max3  = currentCalcResult.baseOt3 || 0;

      if (currentCalcResult.type === 'weekday') {
          let allocate15 = Math.min(reqMins, max15);
          currentCalcResult.ot15 = allocate15; 
      } else {
          let allocate1 = Math.min(reqMins, max1);
          let remMins = Math.max(0, reqMins - allocate1);
          let allocate3 = Math.min(remMins, max3);

          currentCalcResult.ot1 = allocate1;
          currentCalcResult.ot3 = allocate3;
      }

      const autoPilotBadge = document.getElementById('autoPilotBadge');
      if (autoPilotBadge) {
          autoPilotBadge.innerHTML = '✨ Auto-Pilot';
          autoPilotBadge.style.background = '#fef08a';
          autoPilotBadge.style.color = '#854d0e';
      }

      if (currentCalcResult.type === 'weekday') {
          let disp15 = document.getElementById('disp_total15');
          if (disp15) {
              disp15.innerHTML = fmt(currentCalcResult.ot15) + (currentCalcResult.ot15 < max15 ? ` <span style="font-size:0.75rem; color:#ef4444; font-weight:700;">(ปรับลด)</span>` : '') + ' ✏️';
          }
      } else {
          let disp1 = document.getElementById('disp_total1');
          let disp3 = document.getElementById('disp_total3');
          if (disp1) disp1.innerHTML = fmt(currentCalcResult.ot1) + (currentCalcResult.ot1 < max1 ? ` <span style="font-size:0.75rem; color:#ef4444; font-weight:700;">(ปรับลด)</span>` : '') + ' ✏️';
          if (disp3) disp3.innerHTML = fmt(currentCalcResult.ot3) + (currentCalcResult.ot3 < max3 ? ` <span style="font-size:0.75rem; color:#ef4444; font-weight:700;">(ปรับลด)</span>` : '') + ' ✏️';
      }
  };

  window.editLiveOTHours = function(rateKey) {
      if (!currentCalcResult) return;

      let maxLimit = 0;
      let currentVal = 0;
      let label = "";

      if (rateKey === '15') { maxLimit = currentCalcResult.baseOt15; currentVal = currentCalcResult.ot15; label = "OT x1.5"; }
      if (rateKey === '1')  { maxLimit = currentCalcResult.baseOt1; currentVal = currentCalcResult.ot1; label = "OT x1"; }
      if (rateKey === '3')  { maxLimit = currentCalcResult.baseOt3; currentVal = currentCalcResult.ot3; label = "OT x3"; }

      const currentHours = (Math.round((currentVal / 60) * 10)/10).toString().replace('.0', '');
      const maxHours = (maxLimit / 60).toFixed(2);

      const newValStr = prompt(`🛠️ แก้ไขชั่วโมง ${label} ด้วยตนเอง\n(โปรแกรมประเมินไว้สูงสุดที่เบิกได้คือ: ${maxHours} ชม.)`, currentHours);
      
      if (newValStr !== null) {
          const newVal = parseFloat(newValStr);
          if (isNaN(newVal) || newVal < 0) { alert('❌ ตัวเลขไม่ถูกต้อง'); return; }
          
          const newValMinutes = Math.round(newVal * 60);
          if (newValMinutes > maxLimit + 1) { alert(`❌ เกินเวลาที่ทำได้จริงในเรตนี้ (${maxHours} ชม.)`); return; }

          if (rateKey === '15') currentCalcResult.ot15 = newValMinutes;
          if (rateKey === '1')  currentCalcResult.ot1 = newValMinutes;
          if (rateKey === '3')  currentCalcResult.ot3 = newValMinutes;

          const dispEl = document.getElementById(`disp_total${rateKey}`);
          if (dispEl) {
              dispEl.innerHTML = fmt(newValMinutes) + ` <span style="font-size:0.75rem; color:#ea580c; font-weight:700;">(Manual)</span> ✏️`;
          }

          let newTotalReqMins = 0;
          if (currentCalcResult.type === 'weekday') {
              newTotalReqMins = currentCalcResult.ot15;
          } else {
              newTotalReqMins = (currentCalcResult.ot1 || 0) + (currentCalcResult.ot3 || 0);
          }
          
          const reqInput = document.getElementById('requestOTInput');
          if (reqInput) {
              reqInput.value = (Math.round((newTotalReqMins / 60) * 10) / 10).toString().replace('.0', '');
              
              const autoPilotBadge = document.getElementById('autoPilotBadge');
              if (autoPilotBadge) {
                  autoPilotBadge.innerHTML = '⚙️ Manual Edit';
                  autoPilotBadge.style.background = '#e2e8f0';
                  autoPilotBadge.style.color = '#475569';
              }
          }
      }
  };

  function rowHTML(range, rateClass, rateText, mins){
    return `<div class="row"><div class="time">${range}</div><div class="rate ${rateClass}">${rateText}</div><div class="dur">${fmt(mins)}</div></div>`;
  }

  function generateResultHTML(type, dateVal, startMin, endMin, totalMinutes, wkResult) {
      const thaiDate = formatThaiDate(dateVal);
      const timeRange = `${fmtTime(startMin)} - ${fmtTime(endMin)}`;
      const head = `<div class="result-head"><div class="tt">สรุป</div><div class="meta-pill"><span class="m-date">📅 ${thaiDate}</span><span class="m-time">⏰ ${timeRange}</span></div></div>`;
      let body = '';

      let dispTotal = 0;
      let maxOT = 0;
      let totalBoxTop = '';

      if (type === 'weekday') {
          dispTotal = totalMinutes; 
          maxOT = wkResult.total15 || 0; 
          totalBoxTop = `<div class="total-line"><span class="k">รวม ×1.5</span><span class="v ot-editable" id="disp_total15" onclick="editLiveOTHours('15')" title="คลิกเพื่อระบุเวลา x1.5 ด้วยตนเอง">${fmt(wkResult.total15)} ✏️</span></div>`;
      } else {
          const ot1 = wkResult.totals[1] || 0;
          const ot3 = wkResult.totals[3] || 0;
          dispTotal = wkResult.totalMinutes; 
          maxOT = ot1 + ot3;
          totalBoxTop = `<div class="total-line"><span class="k">รวม ×1</span><span class="v ot-editable" id="disp_total1" onclick="editLiveOTHours('1')" title="คลิกเพื่อระบุเวลา x1 ด้วยตนเอง">${fmt(ot1)} ✏️</span></div><div class="total-line"><span class="k">รวม ×3</span><span class="v ot-editable" id="disp_total3" onclick="editLiveOTHours('3')" title="คลิกเพื่อระบุเวลา x3 ด้วยตนเอง">${fmt(ot3)} ✏️</span></div>`;
      }

      const maxHours = maxOT / 60;
      const maxHoursClean = maxHours % 1 === 0 ? maxHours : maxHours.toFixed(2);
      
      const reqHtml = `
          <div class="total-line" style="margin-top: 10px; border-top: 1px dashed var(--border); padding-top: 12px; align-items: center;">
              <span class="k" style="color:#0284c7; font-weight:800;">
                  📝 ขอเบิกเวลา OT (ชม.) 
                  <span id="autoPilotBadge" style="background:#fef08a; color:#854d0e; padding:2px 6px; border-radius:6px; font-size:0.7rem; vertical-align:middle; margin-left:4px; box-shadow:0 1px 2px rgba(0,0,0,0.1);">✨ Auto-Pilot</span>
              </span>
              <div style="display: flex; flex-direction: column; align-items: flex-end;">
                  <input type="number" id="requestOTInput" class="mini-input" style="width:100px; border-color:#38bdf8; background:#f0f9ff; font-size:1.1rem; text-align:center;" min="0" max="${maxHours}" step="0.5" value="${maxHoursClean}" placeholder="เช่น 4" oninput="handleAutoPilotOT(this.value)">
                  <div id="requestOTError" style="color:var(--danger); font-size:0.75rem; display:none; margin-top:4px;">❌ ห้ามเกิน ${maxHoursClean} ชม.</div>
              </div>
          </div>
      `;

      if (type === 'weekday') {
          body = `<div class="result-section"><div class="result-title"><span class="i">🔔</span>ช่วงเวลาที่นับเป็น OT ×1.5</div><div class="rows">${wkResult.rowsHTML || '<div class="note-sub">ไม่มีช่วงเวลาที่ทับ</div>'}</div>${wkResult.breaks.length?`<div class="breaks">${wkResult.breaks.map(b=>`<span class="break-chip">${b}</span>`).join('')}</div>`:''}</div><div class="result-section"><div class="total-box">${totalBoxTop}<div class="total-line em"><span class="k">⏱️ เวลาทำงานรวม</span><span class="v">${fmt(dispTotal)}</span></div>${reqHtml}</div></div>`;
      } else {
          body = `<div class="result-section"><div class="result-title"><span class="i">🔔</span>ช่วงเวลาที่นับงานและเรตค่าตอบแทน</div><div class="rows">${wkResult.rowsHTML || '<div class="note-sub">ไม่มีช่วงเวลาที่ทับ</div>'}</div>${wkResult.breaks.length?`<div class="breaks">${wkResult.breaks.map(b=>`<span class="break-chip">${b}</span>`).join('')}</div>`:''}</div><div class="result-section"><div class="total-box">${totalBoxTop}<div class="total-line em"><span class="k">⏱️ เวลาทำงานรวม</span><span class="v">${fmt(dispTotal)}</span></div>${reqHtml}</div></div>`;
      }
      return `<div class="result-wrap" style="outline:none;">${head}${body}</div>`;
  }

  function calculateCore(start, end, dateVal, type) {
      if(!start || !end || !dateVal) return null;
      if(start === '-' || end === '-') return null;
      let startMin = toMinutes(start);
      let endMin = toMinutes(end);
      if(!isFinite(startMin) || !isFinite(endMin)) return null;
      if (endMin < startMin || (typeof end === 'string' && end.startsWith('00:'))) endMin += 24 * 60; 
      if (startMin > 720 && startMin < 780) startMin = 780;
      if (endMin > 720 && endMin < 780) endMin = 720;
      
      startMin = Math.ceil(startMin / 30) * 30;
      endMin = Math.floor(endMin / 30) * 30;
      
      if(endMin <= startMin) return null;

      let totalMinutes = endMin - startMin;
      if(Math.max(0,Math.min(endMin,MIN(13,0))-Math.max(startMin,MIN(12,0)))>0) totalMinutes-=LUNCH_BREAK_MIN;
      if(endMin>=MIN(19,30)) totalMinutes-=DINNER_BREAK_MIN;

      const timeRange = `${fmtTime(startMin)} - ${fmtTime(endMin)}`;
      let ot15=0, ot1=0, ot3=0, html = '', maxOTMinutes = 0, dispTotalMinutes = 0;

      if(type === 'weekday'){
          const wk15 = computeWeekday15(startMin, endMin); 
          ot15 = wk15.total15; 
          html = generateResultHTML(type, dateVal, startMin, endMin, totalMinutes, wk15);
          maxOTMinutes = wk15.total15;
          dispTotalMinutes = totalMinutes; 
      } else {
          const wk = computeWeekend(startMin, endMin);
          ot1 = wk.totals[1] || 0;
          ot3 = wk.totals[3] || 0;
          html = generateResultHTML(type, dateVal, startMin, endMin, totalMinutes, wk);
          maxOTMinutes = (wk.totals[1]||0) + (wk.totals[3]||0);
          dispTotalMinutes = wk.totalMinutes;
      }
      return { date: dateVal, type: type, timeRange: timeRange, start: start, end: end, ot15: ot15, ot1: ot1, ot3: ot3, html: html, maxOTMinutes: maxOTMinutes, dispTotalMinutes: dispTotalMinutes };
  }

  function computeWeekday15(startMin,endMin){
    const sessions=[[MIN(0,0),MIN(8,0)],[MIN(17,0),MIN(24,0)],[MIN(24,0),MIN(32,0)]]; 
    let total15=0, rowsHTML='', breaks=[];
    for(const [s,e] of sessions){
      const from=Math.max(startMin,s), to=Math.min(endMin,e), ov=Math.max(0,to-from);
      if(ov>0){
        const f=fmtTime(from); const t=fmtTime(to);
        rowsHTML += rowHTML(`${f}–${t}`,'x15','×1.5',ov);
        total15 += ov;
      }
    }
    if(endMin>=MIN(19,30)){ total15=Math.max(0,total15-DINNER_BREAK_MIN); breaks.push('หักพัก 30 นาที (19:30–20:00)'); }
    return { rowsHTML, breaks, total15 };
  }

  function computeWeekend(startMin,endMin,totalMinutes){
    const sess=[[MIN(0,0),MIN(8,0),3],[MIN(8,0),MIN(17,0),1],[MIN(17,0),MIN(24,0),3],[MIN(24,0),MIN(32,0),3]];
    let rowsHTML='', totals={1:0,3:0}, breaks=[];
    for(const [s,e,r] of sess){
      const from=Math.max(startMin,s), to=Math.min(endMin,e), ov=Math.max(0,to-from);
      if(ov>0){
        const f=fmtTime(from); const t=fmtTime(to);
        rowsHTML += rowHTML(`${f}–${t}`, r===3?'x3':'x1', `×${r}`, ov);
        totals[r]=(totals[r]||0)+ov;
      }
    }
    const L1=MIN(12,0), L2=MIN(13,0);
    if(Math.max(0,Math.min(endMin,L2)-Math.max(startMin,L1))>0){
      totals[1]=Math.max(0,(totals[1]||0)-LUNCH_BREAK_MIN); breaks.push('หักพัก 1 ชม. (12:00–13:00)');
    }
    if(endMin>=MIN(19,30)){ totals[3]=Math.max(0,(totals[3]||0)-DINNER_BREAK_MIN); breaks.push('หักพัก 30 น. (19:30–20:00)'); }
    const totalCalc = (totals[1]||0) + (totals[3]||0);
    return { rowsHTML, breaks, totals, totalMinutes: totalCalc };
  }

  function sortHistory() {
      otHistory.sort((a, b) => {
          let plainA = getPlainName(a.driver);
          let plainB = getPlainName(b.driver);

          const indexA = drivers.findIndex(d => d.name === plainA);
          const indexB = drivers.findIndex(d => d.name === plainB);

          if (indexA !== -1 && indexB !== -1) {
              if (indexA !== indexB) return indexA - indexB;
          } else if (indexA !== -1) {
              return -1; 
          } else if (indexB !== -1) {
              return 1;  
          } else {
              const nameCompare = plainA.localeCompare(plainB, 'th');
              if (nameCompare !== 0) return nameCompare;
          }

          return new Date(a.date) - new Date(b.date);
      });
  }

  function calculateOT(){
    // [FIX] ป้องกัน TypeError ถ้าอิลิเมนต์ไม่ครบหรือไม่ได้เลือกประเภทวัน
    const startEl = document.getElementById('startTime');
    const endEl   = document.getElementById('endTime');
    const dateEl  = document.getElementById('workDate');
    const driverEl = document.getElementById('driverSelect');
    const resultEl = document.getElementById('result');

    if (!startEl || !endEl || !dateEl || !driverEl || !resultEl) {
        console.error('calculateOT: ไม่พบอิลิเมนต์ที่จำเป็น (startTime/endTime/workDate/driverSelect/result)');
        return;
    }

    const start = startEl.value;
    const end   = endEl.value;
    const dateVal = dateEl.value;
    const typeEl = document.querySelector('input[name="type"]:checked');
    const type  = typeEl ? typeEl.value : 'weekday';
    const driver = getPlainName(driverEl.value);

    if(!start || !end || !dateVal) { resultEl.innerHTML='❌ กรุณาระบุข้อมูลให้ครบ'; return; }
    const result = calculateCore(start, end, dateVal, type);
    if(!result) { resultEl.innerHTML='❌ เวลาไม่ถูกต้อง (เช่น เวลาสิ้นสุดก่อนเวลาเริ่ม)'; return; }

    currentCalcResult = { 
        ...result, 
        id: Date.now(), 
        driver: driver,
        baseOt15: result.ot15,
        baseOt1: result.ot1,
        baseOt3: result.ot3
    };

    resultEl.innerHTML = result.html;
    const saveSection = document.getElementById('saveSection');
    if (saveSection) saveSection.style.display = 'flex';

    // [FIX] ปลดล็อกปุ่มบันทึกทุกครั้งที่คำนวณใหม่
    // (เดิมหลังบันทึกสำเร็จปุ่มถูก disable แล้วไม่กลับมา จนกว่าจะกดคำนวณอีกครั้ง)
    const btn = document.getElementById('btnSaveLog');
    if (btn) {
        btn.innerHTML = '📥 บันทึกข้อมูล';
        btn.style.background = '';
        btn.disabled = false;
    }
  }

  function resetFormForNext() {
    CloudStorage.setItem('egat_ot_draft', ""); 
    document.getElementById('driverSelect').value = ''; 
    document.getElementById('startTime').value = '08:00';
    document.getElementById('endTime').value    = '17:00';
    document.getElementById('result').innerHTML = '';
    document.getElementById('saveSection').style.display = 'none';
    currentCalcResult = null;
    
    const now = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Bangkok"}));
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const dateInput = document.getElementById('workDate');
    if(dateInput) {
        dateInput.value = `${year}-${month}-${day}`;
        syncDateDisplay('workDate', 'workDateShow');
    }
    updateThaiDateDisplay();
    
    saveFormDraft(); 
    
    document.querySelector('.card').scrollIntoView({ behavior: 'smooth' });
  }

  function editInline(id) {
      editingRowId = id;
      renderHistory(); 
  }

  function saveInline(id) { 
      const dateInp = document.getElementById('editDate').value;
      const startInp = (document.getElementById('editStart').value || '').trim();
      const endInp = (document.getElementById('editEnd').value || '').trim();
      const originalIndex = otHistory.findIndex(x => x.id === id);
      if(originalIndex === -1) return;
      const originalItem = otHistory[originalIndex];

      if(!dateInp) { alert('กรุณาระบุวันที่'); return; }
      if(!startInp || startInp === '-' || !endInp || endInp === '-') {
          alert('กรุณาระบุเวลาเข้าและเวลาออกให้ถูกต้อง เช่น 08:00 - 17:00');
          return;
      }

      const d = new Date(dateInp);
      const day = d.getDay();
      let newType = (day === 0 || day === 6) ? 'weekend' : 'weekday';
      if (dateInp === originalItem.date) newType = originalItem.type;

      const newResult = calculateCore(startInp, endInp, dateInp, newType);

      if(newResult) {
          newResult.id = originalItem.id;
          newResult.driver = getPlainName(originalItem.driver); 
          newResult.isPending = false; 
          newResult.isTemplate = false; 
          
          if (originalItem.isIncomplete) {
              newResult.isIncomplete = true;
              newResult.incompleteReason = originalItem.incompleteReason;
          }

          newResult.baseOt15 = newResult.ot15;
          newResult.baseOt1 = newResult.ot1;
          newResult.baseOt3 = newResult.ot3;

          let oldReq = parseFloat(originalItem.requestOT);
          let newMaxHr = newResult.maxOTMinutes / 60;
          
          if (!isNaN(oldReq) && oldReq <= newMaxHr && !originalItem.isPending) {
              newResult.requestOT = oldReq;
          } else {
              newResult.requestOT = newMaxHr;
          }

          let finalReqMins = Math.round(newResult.requestOT * 60);
          if (newResult.type === 'weekday') {
              newResult.ot15 = Math.min(finalReqMins, newResult.ot15);
          } else {
              let max1 = newResult.ot1;
              let max3 = newResult.ot3;
              newResult.ot1 = Math.min(finalReqMins, max1);
              let rem = Math.max(0, finalReqMins - newResult.ot1);
              newResult.ot3 = Math.min(rem, max3);
          }

          otHistory[originalIndex] = newResult;
          
          sortHistory(); 
          try { CloudStorage.setItem('egat_ot_history', JSON.stringify(otHistory)); } catch(e){}
              
          const driverFilterVal = document.getElementById('historyDriverFilter').value;
          let targetMonth = null;
          let targetYear = null;
          
          if (!showAll) {
              const historyPickerVal = document.getElementById('historyMonthPicker').value;
              if (historyPickerVal) {
                  const [y, m] = historyPickerVal.split('-');
                  targetMonth = parseInt(m) - 1;
                  targetYear = parseInt(y);
              }
          }

          const currentFiltered = otHistory.filter(item => {
              if(!showAll && targetMonth !== null) {
                  const dateObj = new Date(item.date);
                  if(dateObj.getMonth() !== targetMonth || dateObj.getFullYear() !== targetYear) return false;
              }
              if (driverFilterVal !== "") {
                  if (getPlainName(item.driver) !== getPlainName(driverFilterVal)) return false;
              }
              return true;
          });

          const currentFilteredIndex = currentFiltered.findIndex(item => item.id === newResult.id);
          if (currentFilteredIndex !== -1 && currentFilteredIndex < currentFiltered.length - 1) {
              const nextItem = currentFiltered[currentFilteredIndex + 1];
              editingRowId = nextItem.id;
          } else {
              editingRowId = null;
          }
          renderHistory();
      } else {
          alert('❌ ข้อมูลไม่ถูกต้อง');
      }
  }

  function moveInline(step) {
      const currentVisualIndex = filteredIds.indexOf(editingRowId);
      if (currentVisualIndex !== -1) {
          const nextVisualIndex = currentVisualIndex + step;
          if (nextVisualIndex >= 0 && nextVisualIndex < filteredIds.length) {
              editingRowId = filteredIds[nextVisualIndex];
              renderHistory();
          }
      }
  }

  function cancelInline() {
      editingRowId = null;
      renderHistory();
  }

  function openResetModal() {
      const adminSec = document.getElementById('view-admin');
      const isAdminView = adminSec && !adminSec.classList.contains('hidden') && adminSec.style.display !== 'none';
      let monthText = '';
      if (isAdminView) {
          const admDisplay = document.getElementById('adminMonthDisplay');
          monthText = admDisplay ? admDisplay.innerText : '';
      } else {
          const histDisplay = document.getElementById('historyDateDisplay');
          monthText = histDisplay ? histDisplay.innerText : '';
      }

      const driverFilterVal = isAdminView ? '' : (document.getElementById('historyDriverFilter') ? document.getElementById('historyDriverFilter').value : '');
      const btnResetMonth = document.getElementById('btnResetMonth');
      
      if (btnResetMonth) {
          if (driverFilterVal) {
              let plainName = getPlainName(driverFilterVal);
              btnResetMonth.innerHTML = `📅 รีเซ็ตเฉพาะคนที่เลือกอยู่ (${plainName})`;
          } else {
              btnResetMonth.innerHTML = `📅 รีเซ็ตเฉพาะเดือนนี้ ${monthText ? '(' + monthText + ')' : ''} (ทุกคน)`;
          }
      }

      document.getElementById('resetOptionModal').classList.add('show');
  }

  function closeResetModal() {
      document.getElementById('resetOptionModal').classList.remove('show');
  }

  function resetCurrentMonth() {
      closeResetModal(); 

      const adminSec = document.getElementById('view-admin');
      const isAdminView = adminSec && !adminSec.classList.contains('hidden') && adminSec.style.display !== 'none';
      const driverFilterVal = isAdminView ? '' : (document.getElementById('historyDriverFilter') ? document.getElementById('historyDriverFilter').value : '');
      let targetMonth = null;
      let targetYear = null;
      
      let monthPickerVal = '';
      if (isAdminView && typeof getAdminMonthKey === 'function') {
          monthPickerVal = getAdminMonthKey();
      } else {
          const hp = document.getElementById('historyMonthPicker');
          monthPickerVal = hp ? hp.value : '';
      }

      if (!showAll && monthPickerVal) {
          const [y, m] = monthPickerVal.split('-');
          targetMonth = parseInt(m) - 1;
          targetYear = parseInt(y);
      } else if (!showAll) {
          alert('กรุณาเลือกเดือนก่อนครับ'); return; 
      }

      let plainCurrentDriver = getPlainName(driverFilterVal);

      let count = 0;
      otHistory.forEach(item => {
          let isMatch = true;
          if (!showAll) {
              const d = new Date(item.date);
              if(d.getMonth() !== targetMonth || d.getFullYear() !== targetYear) isMatch = false;
          }
          
          let dName = getPlainName(item.driver);
          
          if (plainCurrentDriver && dName !== plainCurrentDriver) isMatch = false;
          
          if(isMatch) {
              item.isPending = true; item.isLeave = false;
              delete item.leaveType; delete item.isIncomplete; delete item.incompleteReason;
              item.start = '08:00'; item.end = '17:00'; item.ot15 = 0; item.ot1 = 0; item.ot3 = 0; item.requestOT = 0;
              count++;
          }
      });
      CloudStorage.setItem('egat_ot_history', JSON.stringify(otHistory));
      renderHistory();
      if (typeof renderAdminDashboard === 'function') renderAdminDashboard();
      alert(`รีเซ็ตค่ากลับเป็นแบบร่างเรียบร้อย จำนวน ${count} รายการ`);
  }

  function openDeleteModal() {
      const adminSec = document.getElementById('view-admin');
      const isAdminView = adminSec && !adminSec.classList.contains('hidden') && adminSec.style.display !== 'none';
      let monthText = '';
      if (isAdminView) {
          const admDisplay = document.getElementById('adminMonthDisplay');
          monthText = admDisplay ? admDisplay.innerText : '';
      } else {
          const histDisplay = document.getElementById('historyDateDisplay');
          monthText = histDisplay ? histDisplay.innerText : '';
      }

      const driverFilterVal = isAdminView ? '' : (document.getElementById('historyDriverFilter') ? document.getElementById('historyDriverFilter').value : '');
      const btnDeleteMonth = document.getElementById('btnDeleteMonth');
      
      if (btnDeleteMonth) {
          if (driverFilterVal) {
              let plainName = getPlainName(driverFilterVal);
              btnDeleteMonth.innerHTML = `📅 ลบเฉพาะคนที่เลือกอยู่ (${plainName})`;
          } else {
              btnDeleteMonth.innerHTML = `📅 ลบเฉพาะเดือนนี้ ${monthText ? '(' + monthText + ')' : ''} (ทุกคน)`;
          }
      }

      document.getElementById('deleteOptionModal').classList.add('show');
  }

  function closeDeleteModal() {
      document.getElementById('deleteOptionModal').classList.remove('show');
  }

  function deleteCurrentMonth() {
      closeDeleteModal();

      const adminSec = document.getElementById('view-admin');
      const isAdminView = adminSec && !adminSec.classList.contains('hidden') && adminSec.style.display !== 'none';
      const driverFilterVal = isAdminView ? '' : (document.getElementById('historyDriverFilter') ? document.getElementById('historyDriverFilter').value : '');
      let targetMonth = null;
      let targetYear = null;
      
      let monthPickerVal = '';
      let mText = '';
      if (isAdminView && typeof getAdminMonthKey === 'function') {
          monthPickerVal = getAdminMonthKey();
          const admDisplay = document.getElementById('adminMonthDisplay');
          mText = admDisplay ? admDisplay.innerText : monthPickerVal;
      } else {
          const hp = document.getElementById('historyMonthPicker');
          monthPickerVal = hp ? hp.value : '';
          const histDisplay = document.getElementById('historyDateDisplay');
          mText = histDisplay ? histDisplay.innerText : monthPickerVal;
      }

      if (!showAll && monthPickerVal) {
          const [y, m] = monthPickerVal.split('-');
          targetMonth = parseInt(m) - 1;
          targetYear = parseInt(y);
      } else if (!showAll) {
          alert('กรุณาเลือกเดือนก่อนครับ'); return;
      }

      let plainCurrentDriver = getPlainName(driverFilterVal);

      let confirmMsg = "";
      if (showAll) {
          confirmMsg = `⚠️ อันตราย: ยืนยันลบรายการ "ทั้งหมด"?`;
      } else {
          if (plainCurrentDriver) {
              confirmMsg = `⚠️ ยืนยันลบข้อมูลของ "${plainCurrentDriver}"\nประจำเดือน "${mText}" ใช่หรือไม่?`;
          } else {
              confirmMsg = `⚠️ ยืนยันลบข้อมูลของ "ทุกคน"\nประจำเดือน "${mText}" ใช่หรือไม่?`;
          }
      }
      
      if(!confirm(confirmMsg)) return;

      const initialLen = otHistory.length;
      otHistory = otHistory.filter(item => {
          let isMatch = true;
          if (!showAll) {
              const d = new Date(item.date);
              if(d.getMonth() !== targetMonth || d.getFullYear() !== targetYear) isMatch = false;
          }
          
          let dName = getPlainName(item.driver);
          
          if (plainCurrentDriver && dName !== plainCurrentDriver) isMatch = false;
          
          return !isMatch; 
      });
      const deletedCount = initialLen - otHistory.length;
      CloudStorage.setItem('egat_ot_history', JSON.stringify(otHistory));
      
      try { reloadVerifyStatus(); } catch(e) {}
      if(plainCurrentDriver && targetMonth !== null) {
           const monthKey = monthPickerVal;
           if(verifiedStatus[monthKey] && verifiedStatus[monthKey][plainCurrentDriver]) {
               delete verifiedStatus[monthKey][plainCurrentDriver];
               CloudStorage.setItem('egat_ot_verified_status', JSON.stringify(verifiedStatus));
           }
      } else if (!plainCurrentDriver && targetMonth !== null) {
           const monthKey = monthPickerVal;
           if(verifiedStatus[monthKey]) {
               delete verifiedStatus[monthKey];
               CloudStorage.setItem('egat_ot_verified_status', JSON.stringify(verifiedStatus));
           }
      }

      renderHistory();
      if (typeof renderAdminDashboard === 'function') renderAdminDashboard();
      updateBadge();
      alert(`ลบเรียบร้อย จำนวน ${deletedCount} รายการ`);
  }

  function resetHistoryItem(id) {
      if (!confirm('เคลียร์รายการนี้เป็นแบบร่าง (Pending)?')) return;
      const item = otHistory.find(x => x.id === id);
      if(!item) return;
      item.isPending = true;
      item.start = '08:00';
      item.end = '17:00';
      item.ot15 = 0;
      item.ot1 = 0;
      item.ot3 = 0;
      item.requestOT = 0;
      CloudStorage.setItem('egat_ot_history', JSON.stringify(otHistory));
      renderHistory();
  }

function openIncompleteModal() {
  let driverName = getPlainName(document.getElementById('historyDriverFilter').value);
  if (!driverName) {
      driverName = getPlainName(document.getElementById('driverSelect').value);
  }
  
  if (!driverName) {
      alert('⚠️ กรุณาเลือก "พขร." ที่ต้องการแจ้งขาดก่อนครับ\n(เลือกที่ตัวกรองขวาบน หรือที่หน้าคำนวณก็ได้)');
      return;
  }

  let monthVal = '';
  const viewOt = document.getElementById('view-ot');
  const isOtVisible = viewOt && viewOt.classList.contains('active');
  if (isOtVisible) {
      const wDate = getWorkDateSelectedMonth();
      if (wDate) {
          monthVal = `${wDate.year}-${String(wDate.month).padStart(2, '0')}`;
      }
  }
  if (!monthVal) {
      const hp = document.getElementById('historyMonthPicker');
      if (hp && hp.value) monthVal = hp.value;
  }
  if (!monthVal) {
      monthVal = getGlobalSelectedMonth();
  }
  
  if (!monthVal) {
      alert('⚠️ กรุณาเลือก "เดือน" ที่ต้องการบันทึกก่อนครับ');
      return;
  }

  document.getElementById('incDriverSelect').value = driverName;
  document.getElementById('incMonth').value = monthVal;

  const displayEl = document.getElementById('incContextDisplay');
  if(displayEl) {
      displayEl.innerHTML = `<div style="font-size:1.1rem; margin-bottom:4px;">👤 ${driverName}</div><div style="font-size:0.95rem; opacity:0.8;">📅 เดือน ${getThaiMonthYearFull(monthVal)}</div>`;
  }

  document.getElementById('incNote').value = '';
  renderIncDays(); 
  document.getElementById('incompleteModal').classList.add('show');
}

function closeIncompleteModal() {
  document.getElementById('incompleteModal').classList.remove('show');
}

  function renderIncDays() {
      const monthVal = document.getElementById('incMonth').value;
      const grid = document.getElementById('incDaysGrid');
      grid.innerHTML = '';
      if(!monthVal) return;
      const [year, month] = monthVal.split('-').map(Number); 
      const daysInMonth = new Date(year, month, 0).getDate();
      for(let i=1; i<=daysInMonth; i++) {
          const div = document.createElement('div');
          div.className = 'day-item';
          div.textContent = i;
          div.onclick = function() { this.classList.toggle('selected'); };
          grid.appendChild(div);
      }
  }

  function resolveIncomplete(id) {
      if(confirm('ได้รับเอกสารครบถ้วนแล้วใช่หรือไม่?')) {
          const item = otHistory.find(x => x.id === id);
          if(!item) return;
          item.driver = document.getElementById('incDriverSelect').value || item.driver;
          delete item.isIncomplete; delete item.incompleteReason;
          try { CloudStorage.setItem('egat_ot_history', JSON.stringify(otHistory)); } catch(e){}
          renderHistory();
      }
  }

  function addIncNoteText(text) {
      const el = document.getElementById('incNote');
      const current = el.value.trim();
      if(current) el.value = current + ', ' + text; else el.value = text;
      el.focus();
  }

  function saveIncompleteReport() {
      const driver = getPlainName(document.getElementById('incDriverSelect').value);
      const monthVal = document.getElementById('incMonth').value;
      const note = document.getElementById('incNote').value.trim();
      const selectedEls = document.querySelectorAll('#incDaysGrid .day-item.selected');
      let targetDays = [];
      selectedEls.forEach(el => targetDays.push(parseInt(el.textContent)));

      if(!driver) { alert('กรุณาเลือกพนักงาน'); return; }
      if(!monthVal) { alert('กรุณาเลือกเดือน'); return; }
      if(targetDays.length === 0) { alert('กรุณาจิ้มเลือกวันที่ขาดเอกสาร'); return; }
      if(!note) { alert('กรุณาระบุรายละเอียดเอกสารที่ขาด'); return; }

      const [year, month] = monthVal.split('-').map(Number);
      targetDays.sort((a,b)=>a-b);
      let updatedCount = 0; let newCount = 0;

      targetDays.forEach(dayNum => {
          const dateString = getDateString(year, month, dayNum);
          const driverName = driver;
          
          let existingItem = otHistory.find(item => 
              item.date === dateString && 
              getPlainName(item.driver) === driverName
          );
          
          if (!existingItem) {
              existingItem = otHistory.find(item => item.date === dateString && !item.driver);
          }

          if(existingItem) {
              existingItem.driver = driverName; 
              existingItem.isIncomplete = true;
              existingItem.incompleteReason = note;
              updatedCount++;
          } else {
               const newItem = {
                  id: Date.now() + Math.random(), date: dateString, type: 'weekday', driver: driverName,
                  isPending: true, isIncomplete: true, incompleteReason: note,
                  ot15: 0, ot1: 0, ot3: 0, start: '08:00', end: '17:00', requestOT: 0
              };
              otHistory.push(newItem);
              newCount++;
          }
      });
      sortHistory();
      try {
          CloudStorage.setItem('egat_ot_history', JSON.stringify(otHistory));
          renderHistory();
          closeIncompleteModal();
          alert(`✅ บันทึกเรียบร้อย\n- อัปเดต: ${updatedCount}\n- ใหม่: ${newCount}`);
      } catch(e) { alert('Error saving'); }
  }
   
  window.viewDriverMissing = function(driverName, monthKey) {
    const listContainer = document.getElementById('summaryList');
    listContainer.innerHTML = '';
    
    const driverObj = drivers.find(d => d.name === driverName);
    const phone = driverObj ? driverObj.phone : '-';

    const header = document.createElement('div');
    header.style.marginBottom = '15px';
    header.style.borderBottom = '1px solid #e2e8f0';
    header.style.paddingBottom = '10px';
    header.innerHTML = `
        <div style="font-weight:800; font-size:1.1rem; color:var(--brand);">👤 ${driverName}</div>
        <div style="font-size:0.9rem; color:var(--text-muted);">📞 เบอร์โทร: <span style="color:var(--text-main); font-weight:600;">${phone || 'ไม่ระบุ'}</span></div>
    `;
    listContainer.appendChild(header);

    // [SYNC FIX] ถ้าส่ง monthKey มา (จากตาราง Admin) ให้ใช้เดือนนั้นโดยตรง
    // ไม่งั้นใช้เดือนจาก picker หน้าสรุปตามเดิม
    let targetMonth = null;
    let targetYear = null;
    if (monthKey) {
        const p = String(monthKey).split('-').map(Number);
        if (p[0] && p[1]) { targetYear = p[0]; targetMonth = p[1] - 1; }
    } else if (!showAll) {
        const historyPickerVal = document.getElementById('historyMonthPicker').value;
        if (historyPickerVal) {
            const [y, m] = historyPickerVal.split('-');
            targetMonth = parseInt(m) - 1;
            targetYear = parseInt(y);
        }
    }

    const items = otHistory.filter(item => {
        // [FIX] ติดตามเฉพาะเอกสารตกค้างจริง — วันลาไม่นำมาแสดง
        if(!item.isIncomplete || item.isLeave) return false;
        
        let dName = getPlainName(item.driver) || "(ไม่ระบุชื่อ)";
        if(dName !== driverName) return false;

        if (!showAll && targetMonth !== null) {
             const d = new Date(item.date);
             if (d.getMonth() !== targetMonth || d.getFullYear() !== targetYear) return false;
        }
        return true;
    });
    
    if(items.length === 0) {
         listContainer.innerHTML += '<div style="text-align:center; color:#047857; padding:20px; font-weight:700;">🎉 เอกสารครบถ้วนแล้ว ไม่มีรายการต้องตาม</div>';
    } else {
         // เก็บเดือนที่เปิดดูไว้ส่งต่อให้ปุ่ม ✔ กันหลุดเดือนตอนกดปิดรายการ
         const mkForBtn = (targetYear !== null && targetMonth !== null)
             ? `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}` : '';
         items.sort((a,b) => new Date(a.date) - new Date(b.date)); 
         items.forEach(item => {
            const el = document.createElement('div');
            el.className = 'summary-list-item';
            el.style.display = 'flex';
            el.style.justifyContent = 'space-between';
            el.style.alignItems = 'center';
            el.style.gap = '10px';
            
            el.innerHTML = `
                <div style="flex:1;">
                    <div class="summary-date">📅 ${formatThaiDate(item.date)}</div>
                    <div class="summary-reason" style="margin-top:4px;">${item.incompleteReason || 'ไม่ระบุสาเหตุ'}</div>
                </div>
                <button onclick="resolveFromModal(${item.id}, '${driverName}', '${mkForBtn}')" 
                        style="border:none; background:#ecfdf5; color:#10b981; width:36px; height:36px; border-radius:10px; cursor:pointer; font-size:1.1rem; flex-shrink:0; display:grid; place-items:center; transition:all 0.2s;"
                        title="ได้รับแล้ว (ติ๊กถูก)"
                        onmouseover="this.style.background='#d1fae5'" 
                        onmouseout="this.style.background='#ecfdf5'">
                    ✔
                </button>
            `;
            listContainer.appendChild(el);
         });
    }

    document.getElementById('summaryModal').classList.add('show');
  };

  window.resolveFromModal = function(id, driverName, monthKey) {
      if(!confirm('ยืนยันได้รับเอกสารแล้ว?')) return;

      const item = otHistory.find(x => x.id === id);
      if(item) {
          delete item.isIncomplete;
          delete item.incompleteReason;
          
          try { CloudStorage.setItem('egat_ot_history', JSON.stringify(otHistory)); } catch(e){}
          
          renderHistory();
          try { if (typeof renderAdminDashboard === 'function') renderAdminDashboard(); } catch(e) {}
          viewDriverMissing(driverName, monthKey);
      }
  }

  function openFollowUpSummary() {
    const currentDriver = getEffectiveDriver(); 
    let monthInput = document.getElementById('historyMonthPicker');
    let targetMonth = null, targetYear = null;
    if(monthInput && monthInput.value) {
        const [y, m] = monthInput.value.split('-'); targetYear = parseInt(y); targetMonth = parseInt(m) - 1;
    } else {
        const workDateVal = document.getElementById('workDate').value;
        if(workDateVal) { const d = new Date(workDateVal); targetMonth = d.getMonth(); targetYear = d.getFullYear(); }
    }
    
    let plainCurrentDriver = getPlainName(currentDriver);

    const incompleteItems = otHistory.filter(item => {
        // [FIX] วันลาไม่นับเป็นรายการค้างส่งเอกสาร
        if(!item.isIncomplete || item.isLeave) return false;
        const d = new Date(item.date);
        if(targetMonth !== null && (d.getMonth() !== targetMonth || d.getFullYear() !== targetYear)) return false;
        
        let dName = getPlainName(item.driver);

        if(plainCurrentDriver && dName !== plainCurrentDriver) return false;
        return true;
    });

    const listContainer = document.getElementById('summaryList');
    listContainer.innerHTML = '';
    if(incompleteItems.length === 0) {
        listContainer.innerHTML = '<div style="text-align:center; padding:20px; color:#94a3b8;">🎉 เย้! ไม่มีรายการค้างส่ง</div>';
    } else {
        incompleteItems.forEach(item => {
            const el = document.createElement('div');
            el.className = 'summary-list-item';
            let dispName = item.driver || 'ไม่ระบุชื่อ';
            if (dispName.match(/^#\d+\s+/)) dispName = dispName.replace(/^#\d+\s+/, "");
            el.innerHTML = `<div><div class="summary-date">📅 ${formatThaiDate(item.date)}</div><div class="summary-driver">👤 ${dispName}</div></div><div class="summary-reason">${item.incompleteReason || 'ไม่ระบุสาเหตุ'}</div>`;
            listContainer.appendChild(el);
        });
    }
    document.getElementById('summaryModal').classList.add('show');
  }
   
  function closeSummaryModal() { document.getElementById('summaryModal').classList.remove('show'); }

  function openCreateOptionModal() {
      document.getElementById('createOptionModal').classList.add('show');
      
      const historyPickerVal = document.getElementById('historyMonthPicker').value;
      const createPicker = document.getElementById('createTargetMonth');
      if(historyPickerVal && createPicker) {
          createPicker.value = historyPickerVal;
          updateCreateMonthDisplay(historyPickerVal); 
      }
  }
   
  function closeCreateOptionModal() {
      document.getElementById('createOptionModal').classList.remove('show');
  }

  function initiateAutoFill(mode) {
      const monthVal = document.getElementById('createTargetMonth').value;
      if(!monthVal) { alert('กรุณาเลือกเดือนที่จะสร้างก่อนครับ'); return; }
      
      closeCreateOptionModal();
      
      let targetDrivers = [];
      
      if(mode === 'single') {
          const filterVal = document.getElementById('historyDriverFilter').value;
          
          if(!filterVal) { 
              const mainDriver = document.getElementById('driverSelect').value;
              if(!mainDriver) { 
                  alert('กรุณาเลือก พขร. ที่ต้องการสร้างรายการก่อนครับ\n(เลือกจากตัวกรอง หรือ หน้าคำนวณก็ได้)'); 
                  return; 
              }
              targetDrivers.push(getPlainName(mainDriver));
          } else {
              targetDrivers.push(getPlainName(filterVal));
          }
      } else {
          if(drivers.length === 0) { alert('ยังไม่มีรายชื่อ พขร. ในระบบ'); return; }
          targetDrivers = drivers.map(d => d.name);
      }
      
      const isFullMonth = confirm(`ยืนยันสร้างรายการสำหรับ ${targetDrivers.length} ท่าน \nประจำเดือน ${getThaiMonthYearFull(monthVal)} แบบทั้งเดือน (1-31) ?\n\n[ตกลง] = สร้างเลย\n[ยกเลิก] = ยกเลิก`);
      if(!isFullMonth) return;
      
      const [yearStr, monthStr] = monthVal.split('-');
      const year = parseInt(yearStr);
      const monthIndex = parseInt(monthStr) - 1; 
      const lastDay = new Date(year, monthIndex + 1, 0).getDate();
      
      let addedCount = 0;
      const monthForHelper = monthIndex + 1; 
      
      targetDrivers.forEach(drvName => {
          for(let dayNum=1; dayNum<=lastDay; dayNum++) {
              const dateString = getDateString(year, monthForHelper, dayNum);
              const exists = otHistory.some(item => 
                  item.date === dateString && 
                  getPlainName(item.driver) === drvName
              );
              
              if(!exists) {
                  const currentDay = new Date(year, monthIndex, dayNum);
                  const dayOfWeek = currentDay.getDay();
                  const type = (dayOfWeek === 0 || dayOfWeek === 6) ? 'weekend' : 'weekday';
                  const pendingItem = { 
                      id: Date.now() + Math.random(), 
                      date: dateString, 
                      type: type, 
                      driver: drvName, 
                      isPending: true, 
                      ot15: 0, ot1: 0, ot3: 0, 
                      start: '08:00', end: '17:00', requestOT: 0 
                  };
                  otHistory.push(pendingItem);
                  addedCount++;
              }
          }
      });
      
      sortHistory();
      try {
          CloudStorage.setItem('egat_ot_history', JSON.stringify(otHistory));
          
          const historyPicker = document.getElementById('historyMonthPicker');
          const historyDisplay = document.getElementById('historyDateDisplay');
          if(historyPicker && historyDisplay) {
              historyPicker.value = monthVal;
              historyDisplay.textContent = getThaiMonthYearFull(monthVal);
          }
          
          if(mode === 'all') {
               const driverFilter = document.getElementById('historyDriverFilter');
               if(driverFilter) driverFilter.value = "";
          }

          showAll = false; 
          updateBadge();
          renderHistory();
          alert(`✅ เพิ่มรายการเรียบร้อย ${addedCount} รายการ`);
      } catch(e) { alert('บันทึกไม่สำเร็จ'); }
  }

  function toggleLeaveFromTable(id, isChecked) {
      const item = otHistory.find(x => x.id === id);
      if(!item) return;
      if(isChecked) {
          item.isLeave = true; item.leaveType = 'la'; item.ot15 = 0; item.ot1 = 0; item.ot3 = 0; item.requestOT = 0; item.start = '-'; item.end = '-';
          // [FIX] ติ๊ก "ลา" = วันลาปกติ — ปลดป้ายเอกสารตกค้างเดิมทิ้ง
          delete item.isIncomplete; delete item.incompleteReason;
      } else {
          item.isLeave = false; item.isPending = true; item.leaveType = undefined; item.start = '08:00'; item.end = '17:00'; item.requestOT = 0;
      }
      try { CloudStorage.setItem('egat_ot_history', JSON.stringify(otHistory)); } catch(e){}
      renderHistory();
  }

  function toggleType(id) {
      const sourceItem = otHistory.find(x => x.id === id);
      if(!sourceItem) return;
      const targetDate = sourceItem.date;
      const newType = sourceItem.type === 'weekday' ? 'weekend' : 'weekday';
      
      otHistory.forEach(item => {
          if(item.date === targetDate) {
              item.type = newType;
              if (!item.isPending && !item.isLeave) { 
                   const result = calculateCore(item.start, item.end, item.date, newType);
                   if(result) {
                       item.ot15 = result.ot15; item.ot1 = result.ot1; item.ot3 = result.ot3; 
                       item.html = result.html; item.timeRange = result.timeRange; item.maxOTMinutes = result.maxOTMinutes;
                   }
              }
          }
      });
      
      try { CloudStorage.setItem('egat_ot_history', JSON.stringify(otHistory)); } catch(e){}
      renderHistory(); 
  }

  function editOTHours(id, rateKey) {
      const item = otHistory.find(x => x.id === id);
      if(!item) return;
      const limitCalc = calculateCore(item.start, item.end, item.date, item.type);
      let currentVal = 0, maxLimit = 0, label = "";
      
      if(rateKey === '15') { currentVal = item.ot15/60; maxLimit = limitCalc.ot15; label = "OT x1.5"; }
      if(rateKey === '1')  { currentVal = item.ot1/60; maxLimit = limitCalc.ot1; label = "OT x1"; }
      if(rateKey === '3')  { currentVal = item.ot3/60; maxLimit = limitCalc.ot3; label = "OT x3"; }
      
      const newValStr = prompt(`แก้ไขชั่วโมง ${label} (สูงสุด ${(maxLimit/60).toFixed(2)})`, (Math.round(currentVal*10)/10).toString().replace('.0',''));
      if(newValStr !== null) {
          const newVal = parseFloat(newValStr);
          if(isNaN(newVal) || newVal < 0) { alert('❌ ตัวเลขไม่ถูกต้อง'); return; }
          const newValMinutes = Math.round(newVal * 60);
          if(newValMinutes > maxLimit + 1) { alert(`❌ เกินเวลาจริง (${(maxLimit/60).toFixed(2)})`); return; }

          let proposedTotal = 0;
          if(rateKey === '15') proposedTotal = newValMinutes; 
          else {
              let ot1 = (rateKey === '1') ? newValMinutes : (item.ot1||0);
              let ot3 = (rateKey === '3') ? newValMinutes : (item.ot3||0);
              proposedTotal = ot1 + ot3;
              const maxTotal = (limitCalc.ot1 || 0) + (limitCalc.ot3 || 0);
              if(proposedTotal > maxTotal + 1) { alert(`❌ เวลารวมเกิน (${(maxTotal/60).toFixed(2)})`); return; }
          }
          
          if(rateKey === '15') item.ot15 = newValMinutes;
          if(rateKey === '1')  item.ot1 = newValMinutes;
          if(rateKey === '3')  item.ot3 = newValMinutes;

          let newTotalMins = (item.ot15 || 0) + (item.ot1 || 0) + (item.ot3 || 0);
          item.requestOT = newTotalMins / 60;
          
          try { CloudStorage.setItem('egat_ot_history', JSON.stringify(otHistory)); } catch(e){}
          renderHistory();
      }
  }

  // [FIX] สร้าง HTML สำหรับ Modal รายละเอียด
  // เดิม viewDetail() พึ่ง item.html ซึ่งถูก "ลบทิ้งตั้งแต่ตอนบันทึก" (ดู CloudStorage.setItem)
  // ทำให้ tempDiv.innerHTML = undefined -> Modal เปิดแล้วไม่มีข้อมูลขึ้นเลย
  // ทางแก้: สร้าง HTML ใหม่จากข้อมูลดิบ (start/end/date/type) ที่ยังอยู่เสมอ
  function buildDetailHTML(item) {
      // 1) ถ้ายังมี html อยู่ (รายการที่ยังไม่ถูกบีบอัด) ใช้ของเดิมได้เลย
      if (item && typeof item.html === 'string' && item.html.trim() !== '') {
          return item.html;
      }

      // 2) ไม่มี html -> คำนวณกลับจากข้อมูลดิบที่เก็บไว้
      if (!item) return '';
      try {
          const type = item.type === 'weekend' ? 'weekend' : 'weekday';
          // แบบร่าง/ลา หรือข้อมูลไม่ครบ สร้างการ์ดข้อมูลต่ำสุดแทน
          if (item.isPending || item.isLeave || !item.start || !item.end || !item.date) {
              return buildFallbackDetailHTML(item);
          }
          const rebuilt = calculateCore(item.start, item.end, item.date, type);
          if (rebuilt && rebuilt.html) return rebuilt.html;
          return buildFallbackDetailHTML(item);
      } catch(e) {
          console.warn('สร้างรายละเอียดไม่สำเร็จ ใช้ข้อมูลพื้นฐานแทน:', e);
          return buildFallbackDetailHTML(item);
      }
  }

  // การ์ดสำรอง: ใช้เมื่อคำนวณกลับไม่ได้ เพื่อให้ผู้ใช้ยังเห็นตัวเลขสำคัญ
  function buildFallbackDetailHTML(item) {
      const thaiDate = item.date ? formatThaiDate(item.date) : '-';
      const req = item.requestOT !== undefined
          ? (Math.round(parseFloat(item.requestOT)*10)/10).toString().replace('.0','')
          : '-';
      const totalAll = (item.ot15||0) + (item.ot1||0) + (item.ot3||0);
      return `<div class="result-wrap" style="outline:none;">`
        + `<div class="result-head"><div class="tt">สรุป</div><div class="meta-pill">`
        + `<span class="m-date">📅 ${thaiDate}</span>`
        + (item.timeRange ? `<span class="m-time">⏰ ${item.timeRange}</span>` : '')
        + `</div></div>`
        + `<div class="result-section"><div class="total-box">`
        + `<div class="total-line"><span class="k">OT ×1.5</span><span class="v">${fmt(item.ot15 || 0)}</span></div>`
        + `<div class="total-line"><span class="k">OT ×1</span><span class="v">${fmt(item.ot1 || 0)}</span></div>`
        + `<div class="total-line"><span class="k">OT ×3</span><span class="v">${fmt(item.ot3 || 0)}</span></div>`
        + `<div class="total-line em"><span class="k">⏱️ รวมทำงาน</span><span class="v">${fmt(totalAll)}</span></div>`
        + `<div class="total-line" style="margin-top:10px;border-top:1px dashed var(--border);padding-top:12px;">`
        + `<span class="k" style="color:#0284c7;font-weight:800;">📝 ขอเบิกเวลา OT (ชม.)</span>`
        + `<span class="v" style="color:#0284c7;">${req}</span></div>`
        + `</div></div></div>`;
  }

  function viewDetail(id) {
      const item = otHistory.find(x => x.id === id);
      if(!item) {
          alert('⚠️ ไม่พบข้อมูลรายการนี้ กรุณารีเฟรชหน้าเว็บแล้วลองใหม่อีกครั้ง');
          return;
      }

      let tempDiv = document.createElement('div');
      tempDiv.innerHTML = buildDetailHTML(item);
      
      tempDiv.querySelectorAll('.ot-editable').forEach(el => {
          el.classList.remove('ot-editable');
          el.removeAttribute('onclick');
          el.removeAttribute('title');
      });

      let d15 = tempDiv.querySelector('#disp_total15');
      if(d15) d15.innerHTML = fmt(item.ot15 || 0);
      let d1 = tempDiv.querySelector('#disp_total1');
      if(d1) d1.innerHTML = fmt(item.ot1 || 0);
      let d3 = tempDiv.querySelector('#disp_total3');
      if(d3) d3.innerHTML = fmt(item.ot3 || 0);

      // [FIX] ปิด input ที่แก้ได้ใน Modal — เดิมยังเหลือช่องกรอก "ขอเบิก" ที่แก้แล้วไม่มีผลกับข้อมูลจริง
      // ทำให้ผู้ใช้เข้าใจผิดว่าแก้แล้วบันทึกได้ เปลี่ยนเป็นข้อความ read-only แทน
      const reqInput = tempDiv.querySelector('#requestOTInput');
      if (reqInput && reqInput.parentElement) {
          const reqVal = item.requestOT !== undefined
              ? (Math.round(parseFloat(item.requestOT)*10)/10).toString().replace('.0','')
              : '-';
          reqInput.parentElement.innerHTML =
              `<span style="font-size: 1.3rem; font-weight: 800; color: #0284c7;">${reqVal}</span>`;
      }

      // ซ่อนข้อความเตือนและ badge ที่ไม่จำเป็นในโหมดดูรายละเอียด
      tempDiv.querySelectorAll('#requestOTError').forEach(el => el.remove());

      let badge = tempDiv.querySelector('#autoPilotBadge');
      if(badge) {
          let isManual = false;
          if(item.baseOt15 !== undefined) {
              if(item.ot15 !== item.baseOt15 || item.ot1 !== item.baseOt1 || item.ot3 !== item.baseOt3) {
                  isManual = true;
              }
          } else {
              isManual = true; 
          }

          if(isManual) {
              badge.innerHTML = '⚙️ Manual Edit';
              badge.style.background = '#e2e8f0';
              badge.style.color = '#475569';
          }
      }

      document.getElementById('modalBody').innerHTML = tempDiv.innerHTML;
      document.getElementById('detailModal').classList.add('show');
  }

  function closeModal() { document.getElementById('detailModal').classList.remove('show'); }
   
  function deleteHistory(id) {
    if(!confirm('ยืนยันลบ?')) return;
    otHistory = otHistory.filter(item => item.id !== id);
    try { CloudStorage.setItem('egat_ot_history', JSON.stringify(otHistory)); updateBadge(); renderHistory(); } catch(e) {}
  }

  function resetOT() {
    const s = document.getElementById('startTime');
    const e = document.getElementById('endTime');
    if(s) s.value = '08:00';
    if(e) e.value = '17:00';
    
    const now = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Bangkok"}));
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
      
    const dateInput = document.getElementById('workDate');
    if(dateInput) {
        dateInput.value = `${year}-${month}-${day}`;
        syncDateDisplay('workDate', 'workDateShow');
    }
      
    updateThaiDateDisplay();
      
    const dayOfWeek = now.getDay();
    const typeVal = (dayOfWeek===0||dayOfWeek===6)?'weekend':'weekday';
    const rad = document.querySelector(`input[name="type"][value="${typeVal}"]`);
    if(rad) { rad.checked=true; updateRadioStyle(); }

    const res = document.getElementById('result');
    if(res) res.innerHTML = '';
    const saveSec = document.getElementById('saveSection');
    if(saveSec) saveSec.style.display = 'none';
    editingRowId = null; 
  }

  // [MOBILE] ใส่ data-label ให้ทุก <td> โดยอ่านชื่อหัวคอลัมน์จาก <thead> อัตโนมัติ
  // ทำให้ CSS แสดงผลแบบ Card View บนมือถือได้ โดยไม่ต้องแก้ innerHTML ทุกจุด
  // (ถ้าแก้ทีละจุดจะพังง่าย และตารางมีหลายชนิด: รายวัน / พขร. / สรุปด่วน)
  function applyMobileCardLabels(tableEl) {
      if (!tableEl) return;
      const headerCells = tableEl.querySelectorAll('thead th');
      if (headerCells.length === 0) return;

      tableEl.querySelectorAll('tbody tr').forEach(row => {
          const cells = row.children;
          for (let i = 0; i < cells.length; i++) {
              const cell = cells[i];
              if (!cell || cell.tagName !== 'TD') continue;
              // ข้ามเซลล์ที่มี colspan (เช่นแถวแก้ไข) เพราะจะทำให้ป้ายชื่อผิดคอลัมน์
              if (cell.colSpan && cell.colSpan > 1) continue;

              let label = headerCells[i] ? (headerCells[i].textContent || '').trim() : '';
              label = label.replace(/^[▼▲]\s*/, '').trim();
              if (label) cell.setAttribute('data-label', label);
          }
      });
  }

  function renderHistory() {
    // [SYNC FIX] โหลดสถานะล่าสุดจาก LocalStorage ทุกครั้งก่อน render
    // กันกรณี Admin เปลี่ยนสถานะไว้ แล้ว พขร. สลับล็อกอินเข้ามาดูแล้วเจอค่าเก่าค้าง
    try { reloadVerifyStatus(); } catch(e) {}
    let targetMonth = null;
    let targetYear = null;
      
    if (!showAll) {
        let historyPickerVal = document.getElementById('historyMonthPicker').value;
        if (!historyPickerVal || !/^\d{4}-\d{2}$/.test(historyPickerVal)) {
            historyPickerVal = getGlobalSelectedMonth();
            document.getElementById('historyMonthPicker').value = historyPickerVal;
        }
        const [y, m] = historyPickerVal.split('-');
        targetMonth = parseInt(m) - 1;
        targetYear = parseInt(y);
    }

    const driverFilterVal = document.getElementById('historyDriverFilter').value;
    const monthsTh = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
      
    if (showAll) {
        document.getElementById('historyDateDisplay').textContent = "แสดงทั้งหมด";
        document.getElementById('historyMonthPicker').value = "";
    } else if (targetMonth !== null) {
        const thaiYear = targetYear + 543; 
        document.getElementById('historyDateDisplay').textContent = `${monthsTh[targetMonth]} ${thaiYear}`;
        
        const monthStr = String(targetMonth + 1).padStart(2, '0');
        document.getElementById('historyMonthPicker').value = `${targetYear}-${monthStr}`; 
    }

    const tbody = document.getElementById('historyList');
    tbody.innerHTML = '';
    let s15=0, s1=0, s3=0;
    let leaveCount = 0; 
    let totalRequestOT = 0; 
    filteredIds = [];

    // [AUTH] พขร. ที่ล็อกอิน เห็นเฉพาะข้อมูลของตัวเอง
    // ต้องไม่แก้ otHistory ต้นฉบับ ไม่งั้นข้อมูลของคนอื่นจะหายถาวรเมื่อบันทึก
    const historyScope = (typeof scopeHistoryForAuth === 'function')
        ? scopeHistoryForAuth(otHistory) : otHistory;
    try { if (typeof renderAuthScopeNotice === 'function') renderAuthScopeNotice(); } catch(e) {}

    if(currentHistoryMode === 'driver') {
        document.querySelector('#historyTable thead').innerHTML = `
            <tr>
                <th class="col-center">#</th>
                <th style="text-align:left;">👤 ชื่อ พขร.</th>
                <th class="col-center th-ot" style="background:#eff6ff; color:#1e3a8a;">x1.5</th>
                <th class="col-center th-ot" style="background:#ecfeff; color:#0e7490;">x1</th>
                <th class="col-center th-ot" style="background:#fff1f2; color:#be123c;">x3</th>
                <th class="col-center th-ot">⏱️ รวม</th>
                <th class="col-center th-ot" style="background:#f0f9ff; color:#0284c7;">📝 ขอเบิก</th>
                <th class="col-center">🏖️ ลา</th>
                <th class="col-center sticky-col">🛡️ สถานะ / การจัดการ</th>
            </tr>
        `;

        const summaryMap = {};

        drivers.forEach(d => {
            summaryMap[d.name] = { ot15:0, ot1:0, ot3:0, leave:0, missingCount:0, requestOT:0, hasData: true, isGhost: false }; 
        });
        
        historyScope.forEach((item) => {
            let isMatch = true;
            if (!showAll && targetMonth !== null) {
                const d = new Date(item.date);
                if (d.getMonth() !== targetMonth || d.getFullYear() !== targetYear) isMatch = false;
            }

            if(isMatch) {
                let plainDriverName = getPlainName(item.driver) || "(ไม่ระบุชื่อ)";

                if(!summaryMap[plainDriverName]) {
                      summaryMap[plainDriverName] = { ot15:0, ot1:0, ot3:0, leave:0, missingCount:0, requestOT:0, hasData: true, isGhost: true };
                }
                
                if(item.isLeave) {
                    summaryMap[plainDriverName].leave++;
                } else if(!item.isPending) {
                    summaryMap[plainDriverName].ot15 += (item.ot15 || 0);
                    summaryMap[plainDriverName].ot1 += (item.ot1 || 0);
                    summaryMap[plainDriverName].ot3 += (item.ot3 || 0);
                    summaryMap[plainDriverName].requestOT += parseFloat(item.requestOT || 0); 
                }

                if(item.isIncomplete && !item.isLeave) {
                    summaryMap[plainDriverName].missingCount++;
                }
            }
        });

        let driverNames = Object.keys(summaryMap);
        
        driverNames.sort((a, b) => {
            const indexA = drivers.findIndex(d => d.name === a);
            const indexB = drivers.findIndex(d => d.name === b);
            if (indexA === -1 && indexB === -1) return a.localeCompare(b, 'th');
            if (indexA === -1) return 1;
            if (indexB === -1) return -1;
            return indexA - indexB;
        });
        
        if (driverFilterVal !== "") {
             let filterNameOnly = getPlainName(driverFilterVal);
             driverNames = driverNames.filter(name => name === filterNameOnly);
        }

        if(driverNames.length === 0) {
            document.getElementById('emptyMsg').style.display = 'block';
        } else {
            document.getElementById('emptyMsg').style.display = 'none';
            driverNames.forEach((name, idx) => {
                const data = summaryMap[name];
                const totalMins = data.ot15 + data.ot1 + data.ot3;
                
                s15 += data.ot15;
                s1 += data.ot1;
                s3 += data.ot3;
                leaveCount += data.leave;
                totalRequestOT += (parseFloat(data.requestOT) || 0); 

                let missingHtml = '-';
                if(data.missingCount > 0) {
                    missingHtml = `<button class="miss-btn" onclick="viewDriverMissing('${name}')" title="คลิกดูรายการที่เอกสารยังไม่ครบ">⚠️ ขาด ${data.missingCount}</button>`;
                }

                const realIndex = drivers.findIndex(d => d.name === name) + 1;
                const displayIndex = (realIndex > 0 && !data.isGhost) ? realIndex : '-';

                const tr = document.createElement('tr');
                // [3 ระดับ + SYNC] ส่ง monthKey ของเดือนที่กำลังดู — Badge ตรงเดือน 100%
                const rowMonthKey = (targetYear !== null && targetMonth !== null)
                    ? `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}` : '';
                // [3 ระดับ] ไฮไลต์แถวเมื่อ "ตรวจสอบแล้ว" ของเดือนนั้นเท่านั้น
                if (getVerifyState(name, rowMonthKey) === ST_VERIFIED) tr.classList.add('verified-row');

                let clearDriverBtnHtml = '';
                if (data.isGhost) {
                    clearDriverBtnHtml = `<button class="btn-verify" style="color: #ef4444;" onclick="removeDriverRowAndData('${name}')" title="ลบรายชื่อและล้างประวัติเดือนนี้ออกจาก Google Sheets คลาวด์">🗑️ ลบ</button>`;
                }

                // [3 ระดับ] เซลล์สถานะ: แอดมินได้ปุ่มกด / พขร.ได้ป้าย read-only (ตรงเดือนที่ดู)
                let extraStatusHtml = (missingHtml !== '-' ? missingHtml : '') + clearDriverBtnHtml;
                let statusCellHtml = buildStatusCellHtml(name, extraStatusHtml, rowMonthKey);

                tr.innerHTML = `
                    <td class="col-center" style="font-weight:bold; color:#cbd5e1;">${displayIndex}</td>
                    <td style="font-weight:700; color:${data.isGhost ? 'var(--danger)' : 'var(--brand)'}; font-size:0.95rem; white-space:nowrap; cursor:pointer; text-decoration:underline; transition:all 0.2s;" onclick="openQuickSummaryModal('${name}', ${targetYear}, ${targetMonth !== null ? targetMonth + 1 : 'null'})" onmouseover="this.style.color='#0284c7'" onmouseout="this.style.color='${data.isGhost ? 'var(--danger)' : 'var(--brand)'}'" title="คลิกเพื่อดูประวัติรายวันของ ${name}">${name} ${data.isGhost ? ' <small style="font-weight:400;color:#94a3b8;">(เกินระบบ)</small>' : ''}</td>
                    <td class="col-center num-cell">${fmtNum(data.ot15)}</td>
                    <td class="col-center num-cell">${fmtNum(data.ot1)}</td>
                    <td class="col-center num-cell">${fmtNum(data.ot3)}</td>
                    <td class="col-center num-cell" style="font-weight:800;">${fmtNum(totalMins)}</td>
                    <td class="col-center num-cell" style="font-weight:800; color:#0284c7;">${fmtHours(totalRequestOT)}</td>
                    <td class="col-center num-cell" style="color:#ef4444; font-weight:700;">${data.leave || 0}</td>
                    <td class="col-center sticky-col">${statusCellHtml}</td>
                `;
                tbody.appendChild(tr);
            });
        }

    } else {
        document.querySelector('#historyTable thead').innerHTML = `
            <tr>
                <th width="4%" class="col-center">🏖️ ลา</th>
                <th width="20%" style="text-align:left; padding-left:10px;">📅 วันที่</th>
                <th width="12%" class="col-center">🏢 ประเภท</th>
                <th width="15%" class="col-center">⏰ ช่วงเวลา</th>
                <th class="col-center th-ot" style="min-width:45px; background:#eff6ff; color:#1e3a8a; border-bottom-color:#bfdbfe;">x1.5</th>
                <th class="col-center th-ot" style="min-width:45px; background:#ecfeff; color:#0e7490; border-bottom-color:#a5f3fc;">x1</th>
                <th class="col-center th-ot" style="min-width:45px; background:#fff1f2; color:#be123c; border-bottom-color:#fecdd3;">x3</th>
                <th width="8%" class="col-center th-ot">⏱️ รวม</th>
                <th width="8%" class="col-center th-ot" style="background:#f0f9ff; color:#0284c7;">📝 ขอเบิก</th>
                <th width="14%" class="col-center sticky-col">⚙️ เครื่องมือ</th>
            </tr>
        `;

        historyScope.forEach((item) => {
            let isMatch = true;
            if (!showAll) {
                 if (targetMonth !== null) {
                    const itemDate = new Date(item.date);
                    if (itemDate.getMonth() !== targetMonth || itemDate.getFullYear() !== targetYear) {
                        isMatch = false;
                    }
                 }
            }
            if (driverFilterVal !== "") {
                const dName = getPlainName(item.driver);
                const filterName = getPlainName(driverFilterVal);
                if(dName !== filterName) {
                    isMatch = false;
                }
            }

            if (isMatch) {
                filteredIds.push(item.id); 
            }
        });

        if(filteredIds.length === 0) {
            document.getElementById('emptyMsg').style.display = 'block';
        } else {
            document.getElementById('emptyMsg').style.display = 'none';
            
            filteredIds.forEach((id) => {
                const item = otHistory.find(x => x.id === id);
                if(!item) return;
                
                if(item.isLeave) { leaveCount++; }

                if(!item.isPending && !item.isLeave) {
                    s15 += item.ot15 || 0; 
                    s1 += item.ot1 || 0; 
                    s3 += item.ot3 || 0;
                    totalRequestOT += (parseFloat(item.requestOT) || 0); 
                }
                
                const tr = document.createElement('tr');
                let totalText = '-';
                if(!item.isPending && !item.isLeave) {
                      const totalMinutes = (item.ot15||0) + (item.ot1||0) + (item.ot3||0);
                      totalText = fmt(totalMinutes);
                }

                const pillClass = item.type === 'weekday' ? 'pill-weekday' : 'pill-weekend';
                const pillText = item.type === 'weekday' ? 'วันธรรมดา' : 'วันหยุด';
                const pillHtml = `<span class="pill ${pillClass}" onclick="toggleType(${id})" style="font-size:0.85rem; padding:6px 12px; border-radius:12px; cursor:pointer; display:inline-block; box-shadow: 0 1px 2px rgba(0,0,0,0.05);" title="คลิกเพื่อสลับประเภทวัน">${pillText}</span>`;

                let dNameClean = getPlainName(item.driver);
                let driverNameHtml = dNameClean ? `<div style="font-size:0.85rem; color:var(--brand); font-weight:700; margin-bottom:4px; display:flex; align-items:center; gap:4px;"><span style="opacity:0.6;">👤</span> ${dNameClean}</div>` : '';
                
                let dateStrHtml = `<div style="font-weight:600; color:${item.isPending ? '#64748b' : 'var(--text-main)'}; font-size:0.9rem; padding-left:2px;">${formatThaiDate(item.date)}</div>`;
                let dateColContent = `${driverNameHtml}${dateStrHtml}`;

                const isChecked = item.isLeave ? 'checked' : '';
                const checkboxHtml = `<input type="checkbox" ${isChecked} onchange="toggleLeaveFromTable(${id}, this.checked)" style="width:16px; height:16px; cursor:pointer;">`;

                if(item.isLeave) {
                    const leavePill = `<span class="pill" style="background:#fef2f2; color:#ef4444; border:1px solid #fecaca; cursor:default; font-size:0.85rem; padding:6px 12px; border-radius:12px;">ลา</span>`;
                    
                    let leaveDateStrHtml = `<div style="font-weight:600; color:#ef4444; font-size:0.9rem; padding-left:2px;">${formatThaiDate(item.date)}</div>`;
                    let leaveDateColContent = `${driverNameHtml}${leaveDateStrHtml}`;

                    let leaveTypeContent = ''; 
                    if(item.isIncomplete && !item.isLeave) {
                           leaveTypeContent = `<div class="inc-box" style="margin:0 auto;"><i>📝</i><span>${item.incompleteReason || 'ขาดเอกสาร'}</span></div>`;
                    } else {
                        leaveTypeContent = '-'; 
                    }

                    tr.innerHTML = `
                        <td class="col-center">${checkboxHtml}</td>
                        <td style="padding-left:10px; vertical-align:middle;">
                            ${leaveDateColContent}
                        </td>
                        <td class="col-center" style="vertical-align:middle;">${leavePill}</td>
                        <td class="col-center" style="font-weight:bold; color:#ef4444; vertical-align:middle;">${leaveTypeContent}</td>
                        <td class="col-center" style="background:#f9fafb; opacity:0.5;">-</td>
                        <td class="col-center" style="background:#f9fafb; opacity:0.5;">-</td>
                        <td class="col-center" style="background:#f9fafb; opacity:0.5;">-</td>
                        <td class="col-center">-</td>
                        <td class="col-center" style="background:#f9fafb; opacity:0.5;">-</td>
                        <td class="col-center">
                            ${item.isIncomplete ? `<button class="action-btn view-btn" onclick="resolveIncomplete(${id})" title="ได้รับเอกสารแล้ว" style="color:#10b981; background:#ecfdf5; margin-right:4px;">✅</button>` : ''}
                            <button class="action-btn del-btn" onclick="deleteHistory(${id})" title="ลบ">🗑️</button>
                        </td>
                    `;
                } else {
                    let timeContent = '';
                    let otHtml = '';
                    let actionBtnHtml = '';
                    
                    let reqValDisplay = '-';
                    if(!item.isPending) {
                        reqValDisplay = item.requestOT !== undefined ? (Math.round(parseFloat(item.requestOT)*10)/10).toString().replace('.0','') : '-';
                    }
                    let requestHtml = '';
                    if(item.isPending) {
                        requestHtml = `<td class="col-center" style="color:#cbd5e1">-</td>`;
                    } else {
                        requestHtml = `<td class="col-center" style="font-weight:800; color:#0284c7; font-size:0.95rem; vertical-align:middle;">${reqValDisplay}</td>`;
                    }

                    let displayTimeRange = '';
                    if (item.timeRange && !item.timeRange.includes('NaN') && item.timeRange !== 'undefined') {
                        displayTimeRange = item.timeRange;
                    } else if (item.start && item.end && item.start !== '-' && item.end !== '-' && !item.start.includes('NaN') && !item.end.includes('NaN')) {
                        displayTimeRange = `${item.start} - ${item.end}`;
                    }

                    const hasNoTime = !displayTimeRange || item.isPending || item.isTemplate || item.start === '-' || item.end === '-';

                    if(hasNoTime) {
                         timeContent = `<span class="time-range pending" onclick="editInline(${id})" title="คลิกเพื่อระบุเวลา">➕ เพิ่ม</span>`;
                    } else {
                         timeContent = `<span class="time-range" onclick="editInline(${id})" title="คลิกเพื่อแก้ไขเวลา">${displayTimeRange}</span>`;
                    }
                    
                    if(item.isIncomplete && !item.isLeave) {
                        timeContent += `<div class="inc-box" style="margin:6px auto 0;"><i>📝</i><span>${item.incompleteReason || 'ขาดเอกสาร'}</span></div>`;
                    }

                    if(hasNoTime) {
                         otHtml = `<td class="col-center" style="color:#cbd5e1">-</td><td class="col-center" style="color:#cbd5e1">-</td><td class="col-center" style="color:#cbd5e1">-</td>`;
                         actionBtnHtml = `<button class="action-btn del-btn" onclick="deleteHistory(${id})" title="ลบ">🗑️</button>`;
                    } else {
                         otHtml = `<td class="col-center"><span class="ot-val val-15" onclick="editOTHours(${id}, '15')">${fmtShort(item.ot15)}</span></td><td class="col-center"><span class="ot-val val-1" onclick="editOTHours(${id}, '1')">${fmtShort(item.ot1)}</span></td><td class="col-center"><span class="ot-val val-3" onclick="editOTHours(${id}, '3')">${fmtShort(item.ot3)}</span></td>`;
                         actionBtnHtml = `<button class="action-btn view-btn" onclick="viewDetail(${id})" title="ดูรายละเอียด">🔍</button><button class="action-btn reset-btn" onclick="resetHistoryItem(${id})" title="เคลียร์เป็นแบบร่าง">🧹</button>`;
                    }
                    
                    if(item.isIncomplete && !item.isLeave) {
                         actionBtnHtml = `<button class="action-btn view-btn" onclick="resolveIncomplete(${id})" title="ได้รับเอกสารแล้ว" style="color:#10b981; background:#ecfdf5; margin-right:4px;">✅</button>` + actionBtnHtml;
                    }

                    if(editingRowId === id) {
                        tr.innerHTML = `
                            <td class="col-center">${checkboxHtml}</td>
                            <td style="padding-left:10px; vertical-align:middle;">
                                ${driverNameHtml}
                                <input type="date" id="editDate" value="${item.date}" class="mini-input" style="width:100%; min-width:110px; padding:4px;" lang="th-TH">
                            </td>
                            <td class="col-center" style="vertical-align:middle;">${pillHtml}</td>
                            <td class="col-center" colspan="4">
                                <div class="edit-row-wrap" style="gap:4px;">
                                    <input type="tel" id="editStart" value="${(item.start && item.start !== '-' && !item.start.includes('NaN')) ? item.start : '08:00'}" class="mini-input" style="width:70px;"><span>-</span><input type="tel" id="editEnd" value="${(item.end && item.end !== '-' && !item.end.includes('NaN')) ? item.end : '17:00'}" class="mini-input" style="width:70px;">
                                    <button onclick="saveInline(${id})" class="mini-btn ok">✔</button>
                                    <button onclick="cancelInline()" class="mini-btn cancel">✖</button>
                                </div>
                            </td>
                            <td class="col-center"><span style="color:#94a3b8; font-size:0.8rem;">...</span></td>
                            <td class="col-center"><span style="color:#94a3b8; font-size:0.8rem;">...</span></td>
                            <td class="col-center sticky-col">...</td>
                        `;
                         setTimeout(() => {
                            const s = document.getElementById('editStart');
                            const e = document.getElementById('editEnd');

                            if(s) {
                                s.focus(); s.select(); 
                                s.addEventListener('input', function(ev) {
                                    formatTimeInput(ev); 
                                    if(this.value.length === 5) { if(e) { e.focus(); e.select(); } }
                                });
                                s.addEventListener('keydown', function(ev) {
                                    if(ev.key === 'Enter') { ev.preventDefault(); if(e) { e.focus(); e.select(); } }
                                });
                            }

                            if(e) {
                                e.addEventListener('input', formatTimeInput);
                                e.addEventListener('keydown', function(ev) {
                                    if(ev.key === 'Enter') { ev.preventDefault(); saveInline(id); }
                                });
                            }
                        }, 50);
                    } else {
                        tr.innerHTML = `
                            <td class="col-center">${checkboxHtml}</td>
                            <td style="padding-left:10px; vertical-align:middle;">
                                ${dateColContent}
                            </td>
                            <td class="col-center" style="vertical-align:middle;">${pillHtml}</td>
                            <td class="col-center" style="vertical-align:middle;">${timeContent}</td>
                            ${otHtml}
                            <td class="col-center" style="font-weight:800; color:var(--brand); font-size:0.95rem; vertical-align:middle;">${totalText}</td>
                            ${requestHtml}
                            <td class="col-center sticky-col" style="vertical-align:middle;">${actionBtnHtml}</td>
                        `;
                    }
                }
                tbody.appendChild(tr);
            });
        }
    }

    document.getElementById('sum15').innerText = (Math.round((s15/60)*10)/10).toFixed(1); 
    document.getElementById('sum1').innerText = (Math.round((s1/60)*10)/10).toFixed(1);
    document.getElementById('sum3').innerText = (Math.round((s3/60)*10)/10).toFixed(1);
    let totalAllMinutes = s15 + s1 + s3;
    document.getElementById('sumLeaveDays').innerText = leaveCount;
    document.getElementById('sumTotal_b').innerText = (Math.round((totalAllMinutes/60)*10)/10).toFixed(1); 
    document.getElementById('sumRequestOT').innerText = (Math.round(totalRequestOT*10)/10).toString().replace('.0', ''); 

    // [MOBILE] เติมป้ายชื่อคอลัมน์ให้การ์ดบนมือถือ
    applyMobileCardLabels(document.querySelector('.history-table')); 
    
    const btnToolbarVerify = document.getElementById('btnToolbarVerify');
    if(btnToolbarVerify && currentHistoryMode === 'daily') {
        let plainName = '';
        if (typeof Auth !== 'undefined' && Auth.isDriver()) {
            plainName = getPlainName(Auth.currentName());
        } else {
            plainName = driverFilterVal ? getPlainName(driverFilterVal) : '';
        }
        let state = (plainName && targetMonth !== null)
            ? getVerifyState(plainName, `${targetYear}-${String(targetMonth+1).padStart(2,'0')}`)
            : ST_PENDING;

        // [FIX] เดิมเช็คแค่ truthiness ทำให้ "ได้รับเอกสาร" (truthy) ถูกแสดงเป็น "ตรวจสอบแล้ว"
        const meta = ST_LABEL[state] || ST_LABEL[ST_PENDING];
        const isAdmin = (typeof Auth !== 'undefined' && Auth.isAdmin());

        // ไฮไลต์สีให้ตรงกับสถานะจริง
        btnToolbarVerify.classList.remove('active', 'st-pending', 'st-received', 'st-verified', 'v-pending', 'v-received', 'v-verified', 'driver-view');
        btnToolbarVerify.classList.add('v-' + state);

        if (isAdmin) {
            btnToolbarVerify.innerHTML = meta.icon + ' ' + meta.text + ' ⟳';
            btnToolbarVerify.title = 'สถานะ: ' + meta.text + ' (คลิกเพื่อเปลี่ยนสถานะ)';
            btnToolbarVerify.style.cursor = 'pointer';
            btnToolbarVerify.disabled = false;
            btnToolbarVerify.style.opacity = '1';
        } else {
            // มุมมอง พขร.: แสดงเป็นป้ายสถานะ (Status Badge) ชัดเจน ไม่จางเป็นปุ่มเสีย
            btnToolbarVerify.innerHTML = meta.icon + ' สถานะ: ' + meta.text;
            btnToolbarVerify.title = 'สถานะการตรวจสอบเดือนนี้: ' + meta.text + ' (ผู้ดูแลระบบเป็นผู้ตรวจสอบ)';
            btnToolbarVerify.classList.add('driver-view');
            btnToolbarVerify.disabled = false;
            btnToolbarVerify.style.opacity = '1';
        }

        // [UX พขร. ข้อ 3] แถบแจ้งเตือนเอกสารไม่ครบสำหรับ พขร. อัตโนมัติ
        const driverIncBanner = document.getElementById('driverIncompleteBanner');
        if (driverIncBanner) {
            if (typeof Auth !== 'undefined' && Auth.isDriver() && plainName) {
                const incCount = otHistory.filter(it => it && !it.isLeave && it.isIncomplete && getPlainName(it.driver) === plainName && (targetMonth === null || (new Date(it.date).getMonth() === targetMonth && new Date(it.date).getFullYear() === targetYear))).length;
                if (incCount > 0) {
                    driverIncBanner.style.display = 'flex';
                    driverIncBanner.innerHTML = `⚠️ <span>ผู้ดูแลระบบแจ้งเอกสารไม่ครบ <b>${incCount} วัน</b> ในเดือนนี้ กรุณาตรวจสอบรายการในตารางและส่งเอกสารเพิ่มเติมครับ</span>`;
                } else {
                    driverIncBanner.style.display = 'none';
                }
            } else {
                driverIncBanner.style.display = 'none';
            }
        }
    }
  }

  /* DOMContentLoaded MAIN */
  document.addEventListener('DOMContentLoaded', () => {
        // [AUTH] ใส่ข้อมูลรายชื่อ พขร. ให้ dropdown ใช้งานได้ก่อนคำนวณสิทธิ์
        try {
            const rawDrivers = JSON.parse(CloudStorage.getItem('egat_drivers'));
            if (Array.isArray(rawDrivers)) {
                drivers = rawDrivers.map(d => (typeof d === 'string'
                    ? { id: Date.now() + Math.random(), name: d, nickname:'', phone:'', affiliation:'', department:'' }
                    : d));
            }
        } catch(e) {}

        initCloudData(); 

        // [AUTH] ใช้สิทธิ์จาก session ที่บันทึกไว้ (ถ้ามี)
        try { if (typeof applyAuthRestrictions === 'function') applyAuthRestrictions(); } catch(e) {} 
        
        const draftStr = CloudStorage.getItem('egat_ot_draft');
        if (draftStr) {
            try {
                const draft = JSON.parse(draftStr);
                if(document.getElementById('driverSelect')) document.getElementById('driverSelect').value = draft.driver || '';
                if(document.getElementById('workDate')) {
                    document.getElementById('workDate').value = draft.date || '';
                    syncDateDisplay('workDate', 'workDateShow');
                }
                if(document.getElementById('startTime')) document.getElementById('startTime').value = draft.start || '08:00';
                if(document.getElementById('endTime')) document.getElementById('endTime').value = draft.end || '17:00';
                
                updateThaiDateDisplay();
                
                const rad = document.querySelector(`input[name="type"][value="${draft.type}"]`);
                if(rad) { rad.checked = true; updateRadioStyle(); }
            } catch(e) {
                window.resetOT();
            }
        } else {
            window.resetOT();
        }

        // [SYNC] ซิงค์เดือนเริ่มต้นตามวันที่ที่เลือกในแบบฟอร์มทันทีที่เปิดแอป
        const wDateInit = getWorkDateSelectedMonth();
        if (wDateInit) {
            const mkInit = `${wDateInit.year}-${String(wDateInit.month).padStart(2, '0')}`;
            setGlobalSelectedMonth(mkInit);
        }

        renderDrivers();
        renderHistory(); 

        ['driverSelect', 'workDate', 'startTime', 'endTime'].forEach(id => {
            const el = document.getElementById(id);
            if(el) {
                el.addEventListener('input', saveFormDraft);
                el.addEventListener('change', saveFormDraft);
            }
        });
        document.querySelectorAll('input[name="type"]').forEach(r => {
            r.addEventListener('change', saveFormDraft);
        });

        const historyBtn = document.getElementById('historyTitleBtn');
        const summaryMenu = document.getElementById('summaryMenu');
        
        if(historyBtn && summaryMenu) {
            historyBtn.addEventListener('click', (e) => {
                e.stopPropagation(); 
                summaryMenu.classList.toggle('show');
            });

            window.addEventListener('click', () => {
                if (summaryMenu.classList.contains('show')) {
                    summaryMenu.classList.remove('show');
                }
            });

            summaryMenu.querySelectorAll('.menu-opt').forEach(opt => {
                opt.addEventListener('click', (e) => {
                    e.stopPropagation(); 
                    const mode = opt.getAttribute('data-mode');
                    setHistoryMode(mode);
                    summaryMenu.classList.remove('show');
                });
            });
        }

        const historyPicker = document.getElementById('historyMonthPicker');
        if(historyPicker) {
            historyPicker.addEventListener('change', (e) => {
                const val = e.target.value; 
                if(val) {
                    updateThaiDateDisplay();
                    showAll = false; 
                    renderHistory();
                }
            });
        }

        const btnToggle = document.getElementById('btnToggle');
        if(btnToggle) {
            btnToggle.addEventListener('click', function() {
                toggleSidebar();
            });
            // รองรับคีย์ลัด: Ctrl+\ เพื่อยุบ/ขยาย
            document.addEventListener('keydown', function(e) {
                if (e.ctrlKey && e.key === '\\') { e.preventDefault(); toggleSidebar(); }
            });
            // คืนค่าสถานะจาก localStorage
            restoreSidebarState();
        }

        const workDateInput = document.getElementById('workDate');
        if(workDateInput) {
            const onWorkDateUserChange = () => {
                updateThaiDateDisplay();
                const wDate = getWorkDateSelectedMonth();
                if (wDate) {
                    const mk = `${wDate.year}-${String(wDate.month).padStart(2, '0')}`;
                    setGlobalSelectedMonth(mk);
                }
            };
            workDateInput.addEventListener('change', onWorkDateUserChange);
            workDateInput.addEventListener('input', onWorkDateUserChange);
        }

        const btnSaveLog = document.getElementById('btnSaveLog');
        if(btnSaveLog) {
            btnSaveLog.addEventListener('click', () => {
                // [AUTH] ผู้เยี่ยมชมคำนวณได้ แต่บันทึกไม่ได้ — ต้องเข้าสู่ระบบก่อน
                if (typeof requireLogin === 'function' && !requireLogin('เพื่อบันทึกข้อมูล OT')) return;

                const driverInput = document.getElementById('driverSelect');
                const driverName = getPlainName(driverInput.value);
                
                if (!driverName) {
                    alert('⚠️ กรุณาระบุ "ชื่อพนักงานขับรถ (พขร.)" ก่อนบันทึกข้อมูลครับ');
                    driverInput.focus(); 
                    driverInput.style.borderColor = '#ef4444';
                    driverInput.style.boxShadow = '0 0 0 4px #fee2e2';
                    setTimeout(() => {
                        driverInput.style.borderColor = '';
                        driverInput.style.boxShadow = '';
                    }, 2000);
                    return;
                }

                const reqInput = document.getElementById('requestOTInput');
                let requestOTVal = 0;
                if (reqInput) {
                    const reqVal = parseFloat(reqInput.value);
                    if (isNaN(reqVal) || reqVal < 0) {
                        alert('⚠️ กรุณาระบุ "ขอเบิกเวลา OT (ชม.)" เป็นตัวเลขให้ถูกต้องครับ');
                        reqInput.focus();
                        return;
                    }
                    const maxVal = parseFloat(reqInput.getAttribute('max'));
                    if (isNaN(maxVal)) {
                        // ไม่มีค่า max ที่อ่านได้ ให้ถือว่าผ่าน ไม่ตั้งใจบล็อกผู้ใช้
                        requestOTVal = reqVal;
                    } else if (reqVal > maxVal + 0.01) {
                        // [FIX] เดิมเรียก getElementById(...).style ตรง ๆ ถ้าไม่มีอิลิเมนต์จะ throw
                        // ทำให้กดบันทึกแล้วเงียบไปเลย (ไม่บันทึก ไม่แจ้ง error)
                        const errBox = document.getElementById('requestOTError');
                        if (errBox) errBox.style.display = 'block';
                        reqInput.focus();
                        return;
                    } else {
                        const errBox2 = document.getElementById('requestOTError');
                        if (errBox2) errBox2.style.display = 'none';
                        requestOTVal = reqVal;
                    }
                }

                // [FIX] เดิม return งับเงียบ ทำให้ผู้ใช้กดแล้วไม่มีอะไรเกิดขึ้น
                if(!currentCalcResult) {
                    alert('⚠️ กรุณากดปุ่ม "⏱️ คำนวณ OT" ก่อนบันทึกข้อมูลครับ');
                    return;
                }

                currentCalcResult.driver = driverName;
                currentCalcResult.requestOT = requestOTVal; 

                const existingIndex = otHistory.findIndex(item => 
                    item.date === currentCalcResult.date && (getPlainName(item.driver) === currentCalcResult.driver)
                );
                if(existingIndex !== -1) { currentCalcResult.id = otHistory[existingIndex].id; otHistory[existingIndex] = currentCalcResult; } 
                else { otHistory.push(currentCalcResult); }
                sortHistory(); 
                try { CloudStorage.setItem('egat_ot_history', JSON.stringify(otHistory)); const btn = document.getElementById('btnSaveLog'); btn.innerHTML = '✅ บันทึกเรียบร้อย'; btn.disabled = true; btn.style.background = '#64748b'; updateBadge(); renderHistory(); } catch(e) { alert('บันทึกไม่สำเร็จ (Storage เต็ม)'); }
            });
        }
        
        const btnCalc = document.getElementById('btnCalc');
        if(btnCalc) { btnCalc.addEventListener('click', calculateOT); }

        document.querySelectorAll('input[name="type"]').forEach(r => {
            r.addEventListener('change', updateRadioStyle);
        });

        document.querySelectorAll('.time-manual').forEach(inp => {
            inp.addEventListener('input', formatTimeInput);
            inp.addEventListener('blur', validateTimeInput);
            inp.addEventListener('focus', function() { this.select(); }); 
        });

        const mainStart = document.getElementById('startTime');
        const mainEnd = document.getElementById('endTime');
        if(mainStart && mainEnd) {
            mainStart.addEventListener('input', function() {
                if(this.value.length === 5) {
                    mainEnd.focus();
                    mainEnd.select(); 
                }
            });

            mainEnd.addEventListener('keydown', function(e) {
                if (e.key === 'Enter') {
                    validateTimeInput({ target: this });
                    this.blur(); 
                    calculateOT(); 
                }
            });
            
            mainStart.addEventListener('keydown', function(e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    mainEnd.focus();
                    mainEnd.select();
                }
            });
        }

        window.addEventListener('keydown', (e) => {
            if(editingRowId !== null) {
                if(e.key === 'ArrowUp') {
                    e.preventDefault();
                    moveInline(-1);
                } else if(e.key === 'ArrowDown') {
                    e.preventDefault();
                    moveInline(1);
                }
            }
            if(e.key === 'Escape') {
                closeModal();
                closeDeleteModal();
                closeResetModal(); 
                closeIncompleteModal();
                closeLeaveModal();
                closeAddDriverModal();
                closeSummaryModal();
                closeCreateOptionModal();
                closeCustomMonthPicker();
                closeBackupModal();
                closeQuickSummaryModal();
                closeAdvancedModal(); 
                
                if(editingRowId !== null) {
                    cancelInline();
                }
            }
        });

        const calcDisplay = document.getElementById('calcDisplay');
        const calcKeys = document.querySelectorAll('.keys button');
        
        function handleCalcInput(k) {
            if(!calcDisplay) return;
            let cur = calcDisplay.value;
            
            if(k === 'C') {
                calcDisplay.value = '0';
            } else if(k === 'BS') {
                calcDisplay.value = cur.length > 1 ? cur.slice(0,-1) : '0';
            } else if(k === '=') {
                try {
                    if (/[^0-9.+\-*/%]/.test(cur)) throw new Error();
                    calcDisplay.value = new Function('return ' + cur)();
                } catch(e) {
                    calcDisplay.value = 'Error';
                    setTimeout(()=>calcDisplay.value='0', 1000);
                }
            } else {
                const ops = ['+','-','*','/','%'];
                const last = cur.slice(-1);
                if(ops.includes(k) && ops.includes(last)) {
                    cur = cur.slice(0,-1);
                }
                if(cur === '0' && !ops.includes(k) && k !== '.') {
                    calcDisplay.value = k;
                } else {
                    calcDisplay.value = cur + k;
                }
            }
        }

        if(calcDisplay && calcKeys.length > 0) {
            calcKeys.forEach(btn => {
                btn.addEventListener('click', () => {
                    handleCalcInput(btn.getAttribute('data-k'));
                });
            });

            window.addEventListener('keydown', (e) => {
                const calcView = document.getElementById('view-calc');
                if (!calcView || !calcView.classList.contains('active')) return;

                let k = null;
                const key = e.key;

                if (/[0-9\.\+\-\*\/%]/.test(key)) {
                    k = key;
                } else if (key === 'Enter' || key === '=') {
                    k = '=';
                    e.preventDefault(); 
                } else if (key === 'Backspace') {
                    k = 'BS';
                } else if (key === 'Escape' || key.toLowerCase() === 'c') {
                    k = 'C';
                }

                if (k) {
                    const btn = document.querySelector(`.keys button[data-k="${k}"]`);
                    if(btn) {
                        btn.style.transform = 'translateY(4px)';
                        btn.style.boxShadow = 'none';
                        setTimeout(() => {
                            btn.style.transform = '';
                            btn.style.boxShadow = '';
                        }, 100);
                    }
                    
                    handleCalcInput(k);
                }
            });
        }

        const dSelect = document.getElementById('driverSelect');
        const hSelect = document.getElementById('historyDriverFilter');
        
        function autoSelectDriverOnEnter(e, inputEl, isHistory) {
            if(e.key === 'Enter') {
                e.preventDefault();
                let val = inputEl.value.trim();
                let match = val.match(/^#?(\d+)$/); 
                if(match) {
                    let idx = parseInt(match[1], 10) - 1;
                    if(idx >= 0 && idx < drivers.length) {
                        inputEl.value = `#${idx + 1} ${drivers[idx].name}`;
                    }
                }
                inputEl.blur(); 
                
                if(isHistory) {
                    handleFilterChange();
                } else {
                    saveFormDraft();
                }
            }
        }

        if(dSelect) {
            dSelect.addEventListener('focus', function() { this.select(); });
            dSelect.addEventListener('click', function() { this.select(); });
            dSelect.addEventListener('keydown', (e) => autoSelectDriverOnEnter(e, dSelect, false));
            dSelect.addEventListener('search', function() { saveFormDraft(); });
        }
        if(hSelect) {
            hSelect.addEventListener('focus', function() { this.select(); });
            hSelect.addEventListener('click', function() { this.select(); });
            hSelect.addEventListener('keydown', (e) => autoSelectDriverOnEnter(e, hSelect, true));
            hSelect.addEventListener('search', function() { handleFilterChange(); });
        }
  });

  /* Actions Trigger in main calculation UI */
  window.openLeaveModal = function() {
      const driverInput = document.getElementById('driverSelect').value;
      const driverName = getPlainName(driverInput);
      let dateVal = document.getElementById('workDate').value;

      if (!driverName) { alert('⚠️ กรุณาระบุชื่อ พขร. ด้านบนก่อนครับ'); return; }
      if (!dateVal) { 
          dateVal = new Date().toISOString().substring(0, 10);
      }

      const monthVal = dateVal.substring(0, 7);

      document.getElementById('leaveDriverSelect').value = driverName;
      document.getElementById('leaveMonth').value = monthVal;

      const displayEl = document.getElementById('leaveContextDisplay');
      if(displayEl) {
          displayEl.innerHTML = `<div style="font-size:1.1rem; margin-bottom:4px;">👤 ${driverName}</div><div style="font-size:0.95rem; opacity:0.8;">📅 เดือน ${getThaiMonthYearFull(monthVal)}</div>`;
      }

      renderLeaveDays(); 
      document.getElementById('leaveModal').classList.add('show');
  };

  window.closeLeaveModal = function() {
      document.getElementById('leaveModal').classList.remove('show');
  };

  function renderLeaveDays() {
      const monthVal = document.getElementById('leaveMonth').value;
      const grid = document.getElementById('leaveDaysGrid');
      grid.innerHTML = '';
      if(!monthVal) return;
      const [year, month] = monthVal.split('-').map(Number); 
      const daysInMonth = new Date(year, month, 0).getDate();
      for(let i=1; i<=daysInMonth; i++) {
          const div = document.createElement('div');
          div.className = 'day-item';
          div.textContent = i;
          div.onclick = function() { this.classList.toggle('selected'); };
          grid.appendChild(div);
      }
  }

  window.saveLeaveReport = function() {
      // [AUTH] ผู้เยี่ยมชมบันทึกวันลาไม่ได้
      if (typeof requireLogin === 'function' && !requireLogin('เพื่อบันทึกวันลา')) return;

      const driver = document.getElementById('leaveDriverSelect').value;
      const monthVal = document.getElementById('leaveMonth').value;
      const selectedEls = document.querySelectorAll('#leaveDaysGrid .day-item.selected');
      let targetDays = [];
      selectedEls.forEach(el => targetDays.push(parseInt(el.textContent)));

      if(!driver) { alert('กรุณาเลือกพนักงาน'); return; }
      if(!monthVal) { alert('กรุณาเลือกเดือน'); return; }
      if(targetDays.length === 0) { alert('กรุณาจิ้มเลือกวันที่ลา'); return; }

      if (!confirm(`ยืนยันบันทึกวันลาของ ${driver}\nจำนวน ${targetDays.length} วัน ใช่หรือไม่?`)) return;

      const [year, month] = monthVal.split('-').map(Number);
      targetDays.sort((a,b)=>a-b);
      let updatedCount = 0; let newCount = 0;

      targetDays.forEach(dayNum => {
          const dateString = getDateString(year, month, dayNum);
          
          const dObj = new Date(dateString);
          const dayOfWeek = dObj.getDay();
          const type = (dayOfWeek === 0 || dayOfWeek === 6) ? 'weekend' : 'weekday';

          let existingItem = otHistory.find(item => 
              item.date === dateString && 
              getPlainName(item.driver) === driver
          );
          
          if (!existingItem) {
              existingItem = otHistory.find(item => item.date === dateString && !item.driver);
          }

          const leaveItemData = {
              date: dateString,
              type: type,
              driver: driver,
              isPending: false,
              isLeave: true,
              leaveType: 'la',
              ot15: 0, ot1: 0, ot3: 0, requestOT: 0, start: '-', end: '-'
              // [FIX] วันลา "ไม่ใช่" เอกสารตกค้าง — ห้ามติดป้าย isIncomplete
          };

          if(existingItem) {
              Object.assign(existingItem, leaveItemData);
              updatedCount++;
          } else {
              const newItem = { id: Date.now() + Math.random(), ...leaveItemData };
              otHistory.push(newItem);
              newCount++;
          }
      });

      sortHistory();
      try { 
          CloudStorage.setItem('egat_ot_history', JSON.stringify(otHistory)); 
          updateBadge(); 
          renderHistory(); 
      } catch(e) {}
      
      alert(`✅ บันทึกวันลาเรียบร้อย ${targetDays.length} วัน`);
      closeLeaveModal();
  };

  window.markAsIncomplete = function() {
      openIncompleteModal();
  };

  window.openQuickSummaryModal = function(overrideName, overrideYear, overrideMonth) {
      let driverName = typeof overrideName === 'string' ? overrideName : null;
      if (!driverName) {
          const driverInput = document.getElementById('driverSelect').value;
          driverName = getPlainName(driverInput);
      }
      
      if (!driverName) {
          alert('⚠️ กรุณาระบุชื่อ พขร. ที่ต้องการดูก่อนครับ (พิมพ์ที่กล่องค้นหาด้านบน หรือคลิกจากรายชื่อในตาราง)');
          return;
      }

    let targetYear, targetMonth;
    if (overrideYear && overrideMonth) {
        targetYear = parseInt(overrideYear);
        targetMonth = parseInt(overrideMonth);
    } else {
        // [PRIORITY] ดึงเดือนจากวันที่ที่เลือกในหน้าคำนวณ OT ก่อนเสมอ
        const wDate = getWorkDateSelectedMonth();
        if (wDate) {
            targetYear = wDate.year;
            targetMonth = wDate.month;
            try {
                const mk = `${targetYear}-${String(targetMonth).padStart(2, '0')}`;
                setGlobalSelectedMonth(mk);
            } catch(e) {}
        } else {
            const [gy, gm] = getGlobalSelectedMonth().split('-').map(Number);
            targetYear = gy;
            targetMonth = gm;
        }
    }
    if (targetYear > 2400) targetYear -= 543;

    const monthTh = (typeof THAI_MONTHS_FULL !== 'undefined' && THAI_MONTHS_FULL[targetMonth - 1])
        ? THAI_MONTHS_FULL[targetMonth - 1]
        : ((typeof THAI_MONTHS_SHORT !== 'undefined' && THAI_MONTHS_SHORT[targetMonth - 1]) || `เดือน ${targetMonth}`);
    const yearTh = targetYear + 543;
    const cleanDriver = getPlainName(driverName);
    document.getElementById('quickSummaryTitle').innerHTML = `📊 สรุปรายการของ ${cleanDriver} <span style="font-size:0.92rem; font-weight:500; color:#64748b; margin-left:6px;">(${monthTh} ${yearTh})</span>`;

    let total15 = 0, total1 = 0, total3 = 0, totalReq = 0;
    const filteredHistory = otHistory.filter(item => {
        if (!item || !item.date) return false;
        if (getPlainName(item.driver) !== cleanDriver) return false;
        let y, m;
        if (typeof item.date === 'string' && /^\d{4}-\d{2}/.test(item.date)) {
            const parts = item.date.split('-');
            y = parseInt(parts[0], 10);
            m = parseInt(parts[1], 10);
        } else {
            const d = new Date(item.date);
            y = d.getFullYear();
            m = d.getMonth() + 1;
        }
        if (y > 2400) y -= 543;
        return y === targetYear && m === targetMonth;
    });

      const listBody = document.getElementById('quickSummaryList');
      listBody.innerHTML = '';

      if (filteredHistory.length === 0) {
          listBody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:30px; color:#94a3b8;">ยังไม่มีข้อมูลในเดือนนี้ครับ</td></tr>';
      } else {
          filteredHistory.sort((a,b) => new Date(a.date) - new Date(b.date));
          filteredHistory.forEach(item => {
              if (!item.isPending && !item.isLeave) {
                  total15 += item.ot15 || 0;
                  total1 += item.ot1 || 0;
                  total3 += item.ot3 || 0;
                  totalReq += parseFloat(item.requestOT) || 0;
              }

              let rowClass = item.isPending ? 'qs-row-pending' : (item.isLeave ? 'qs-row-leave' : '');
              let statusHtml = item.isPending ? '<span style="color:#94a3b8; font-size:0.8rem; background:#f1f5f9; padding:2px 8px; border-radius:8px;">แบบร่าง</span>' : (item.isLeave ? '<span style="color:#ef4444; font-size:0.8rem; background:#fef2f2; padding:2px 8px; border-radius:8px;">ลา</span>' : '<span style="color:#10b981; font-size:0.8rem; background:#ecfdf5; padding:2px 8px; border-radius:8px;">บันทึกแล้ว</span>');
              
              if(item.isIncomplete && !item.isLeave) {
                  statusHtml += '<div style="color:#d97706; font-size:0.75rem; margin-top:2px;">⚠️ ขาดเอกสาร</div>';
              }

              listBody.innerHTML += `
                  <tr class="${rowClass}">
                      <td style="text-align:left; padding-left:20px; font-weight:600;">${formatThaiDate(item.date)}</td>
                      <td style="color:#64748b; font-size:0.85rem;">${item.type === 'weekday' ? 'วันธรรมดา' : 'วันหยุด'}</td>
                      <td>${fmtShort(item.ot15)}</td>
                      <td>${fmtShort(item.ot1)}</td>
                      <td>${fmtShort(item.ot3)}</td>
                      <td style="font-weight:800; color:#0284c7; font-size:1rem;">${item.isPending || item.isLeave ? '-' : (Math.round(parseFloat(item.requestOT)*10)/10).toString().replace('.0','')}</td>
                      <td>${statusHtml}</td>
                  </tr>
              `;
          });
      }

      document.getElementById('quickSummaryBadges').innerHTML = `
          <div class="qs-stat-card qs-blue"><div class="qs-lbl">OT x1.5</div><div class="qs-val">${fmtShort(total15)} <span style="font-size:0.8rem; font-weight:normal;">ชม.</span></div></div>
          <div class="qs-stat-card qs-cyan"><div class="qs-lbl">OT x1</div><div class="qs-val">${fmtShort(total1)} <span style="font-size:0.8rem; font-weight:normal;">ชม.</span></div></div>
          <div class="qs-stat-card qs-rose"><div class="qs-lbl">OT x3</div><div class="qs-val">${fmtShort(total3)} <span style="font-size:0.8rem; font-weight:normal;">ชม.</span></div></div>
          <div class="qs-stat-card qs-primary"><div class="qs-lbl">ขอเบิกสะสม</div><div class="qs-val" style="font-size:1.6rem;">${(Math.round(totalReq*10)/10).toString().replace('.0','')} <span style="font-size:0.9rem; font-weight:normal;">ชม.</span></div></div>
      `;

      document.getElementById('quickSummaryModal').classList.add('show');
      // [MOBILE] เติมป้ายชื่อคอลัมน์ให้การ์ดบนมือถือ
      applyMobileCardLabels(document.querySelector('.qs-table'));
  };

  window.closeQuickSummaryModal = function() {
      document.getElementById('quickSummaryModal').classList.remove('show');
  };
