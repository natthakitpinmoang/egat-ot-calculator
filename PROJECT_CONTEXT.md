# Project Context: EGAT OT Calculator

## 1. ภาพรวมระบบ (System Overview)
* **ชื่อระบบ:** EGAT OT Calculator
* **เวอร์ชันปัจจุบัน:** v7.4.5 (Revert Night Shift, LocalStorage Safety & PWA Cache Sync)
* **วัตถุประสงค์:** เว็บแอปพลิเคชันสำหรับคำนวณ ตรวจสอบ และสรุปผลค่าตอบแทนการทำงานล่วงเวลา (OT) ของพนักงานขับรถ (พขร.) การไฟฟ้าฝ่ายผลิตแห่งประเทศไทย (กฟผ.) ให้ถูกต้องตามระเบียบ 100%
* **เส้นทางโปรเจกต์:** `C:\Users\Administrator\.gemini\antigravity\scratch\egat-ot-calculator`

## 2. สถาปัตยกรรมทางเทคนิค (Technology Stack)
* **Frontend:** Pure Vanilla JavaScript (ES6+), HTML5, CSS3 Variables (ธีมสี กฟผ. Navy Blue `#00306e` และ Amber `#f59e0b`) ไม่มี Third-party Framework
* **PWA & Offline:** `sw.js` (Service Worker) แคชไฟล์ในเครื่องทำงาน Offline 100% และ `manifest.json` ติดตั้งแอปแบบ Standalone
* **Backend:** Serverless RESTful API ผ่าน Google Apps Script (GAS)
* **Database:** Google Sheets / Google Cloud Key-Value Store
* **Storage & Sync:** Hybrid Storage (LocalStorage บันทึก 0 ms + Asynchronous FIFO Queue ซิงก์ขึ้น Cloud) พร้อม Hotfix บีบอัดข้อมูลตัดขยะ HTML ก่อนส่ง

## 3. ตรรกะและสูตรการคิดคำนวณ (Calculation Logic)
* **ปัดเศษ 30 นาที:**
  - เวลาเริ่ม $\rightarrow$ ปัดขึ้น ($\lceil t/30 \rceil \times 30$) เช่น 07:10 $\rightarrow$ 07:30 น.
  - เวลาเลิก $\rightarrow$ ปัดลง ($\lfloor t/30 \rfloor \times 30$) เช่น 20:25 $\rightarrow$ 20:00 น.
  - กะข้ามคืน $\rightarrow$ บวกเวลาสิ้นสุด $+24$ ชม. (1,440 นาที)
* **หักเวลาพัก:**
  - พักเที่ยง (12:00–13:00 น.) = หัก 60 นาที (เฉพาะวันหยุด)
  - พักเย็น (19:30–20:00 น.) = หัก 30 นาที (หากเลิกงาน $\ge$ 19:30 น. โดยไม่มีกะค่ำ/ดึก)
* **อัตราค่าล่วงเวลา:**
  - **วันปกติ (จ.-ศ.):** 08:00–17:00 น. (งานปกติ ไม่คิด OT) / เช้าและเย็น = OT 1.5 เท่า
  - **วันหยุด / นักขัตฤกษ์:** 08:00–17:00 น. = OT 1.0 เท่า (สูงสุด 8 ชม.) / เช้ามืดและค่ำ/ดึก = OT 3.0 เท่า
* **Auto-Pilot OT:** จัดสรรยอดขอเบิกชั่วโมง OT ให้อัตโนมัติ (วันหยุดบรรจุ x1 ก่อน แล้วปัดเข้า x3) รองรับ Manual Edit

## 4. โมดูลหลักของระบบ (Core Modules)
1. **⏱️ คำนวณเวลา OT (Daily Calculation):** ป้อนเวลา คำนวณ แสดงช่วงเวลา และบันทึก
2. **📊 สรุปรายเดือน (Monthly Summary & Export):** สรุปรายวัน, สรุป พขร. ยอดรวม, ฟังก์ชัน Auto-Fill 1-31 วัน, และส่งออก CSV (UTF-8 BOM)
3. **👥 รายชื่อ พขร. (Driver Directory):** จัดการรายชื่อ เบอร์โทร สังกัด และ Drag & Drop เรียงลำดับ
4. **🧮 เครื่องคิดเลข (Built-in Calculator):** เครื่องคิดเลขในตัว
5. **💾 สำรองและกู้คืน (Backup & Restore):** Export / Import JSON

## 5. เอกสารและไฟล์คู่มือ (Manual Documents)
* `EGAT_OT_Calculator_Manual.pdf` (คู่มือฉบับจัดหน้า A4 มาตรฐาน 7 หน้าจบ ไม่ตกขอบ)
* `EGAT_OT_Calculator_Manual.docx` (คู่มือ Microsoft Word ขอบ 1 นิ้วมาตรฐาน)

## 6. แนวทางประหยัดโทเคนและพัฒนาต่อเนื่อง (Token Optimization & Session Protocol)
* **Single Source of Truth & Session Restart:** เมื่องานชิ้นใดเสร็จ หรือแชทเริ่มยาวเกิน 15–20 รอบ ให้บันทึกอัปเดตไฟล์นี้ แล้ว **เปิดแชทใหม่** โดยสั่งให้อ่าน `PROJECT_CONTEXT.md` เพื่อเริ่มงานต่อที่ Turn 1 ทันที (ลดโทเคนสะสมได้ 70–80%)
* **ใช้ `/compact` ระหว่างทาง:** หากยังไม่ต้องการเปิดห้องใหม่ ให้พิมพ์ `/compact` เพื่อบีบอัด Context ประวัติเก่าออก
* **สั่งงานชี้เป้า + Diff Only:** ระบุชื่อไฟล์และฟังก์ชันที่ต้องการแก้ไขโดยตรง และให้ Agent ส่งกลับเฉพาะโค้ดจุดที่แก้ (Diff Snippet) ห้ามพ่นโค้ดทั้งไฟล์
* **ควบคุม Terminal Log:** ใช้คำสั่งที่แสดงผลกระชับ (เช่น `git status -s`, กรอง log ด้วย grep/Select-String) เพื่อไม่ให้ log บวมเข้าสู่แชท
