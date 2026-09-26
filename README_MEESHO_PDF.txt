NCR-OMS — Meesho Supplier Manifest PDF ab seedha upload ho sakti hai (2026-09-26)
====================================================================================

AAPKA SAWAL
-----------
"MEESHO SE YE FILE AATI HAI TRACKING KE LIYE PDF ME TO ISKO KESE KARENGE"
(Aapne 4 real "Supplier Manifest" PDF bheje the — Vardhamiti, Arvagam (2),
KANJUSH)

JO PATA CHALA
--------------
Ye PDF Meesho ka asli dispatch-tracking file hai: Page 1 sirf "Picklist"
hota hai (SKU/Color/Size ki list, isme koi AWB nahi hota). Uske baad har
courier partner ka apna page hota hai ("Courier : Valmo", "Courier :
Delhivery" — ek hi file me dono bhi ho sakte hain, jaisa KANJUSH wali file
me tha), jisme S.No. / Sub Order No. / AWB / SKU / Qty / Size / Packed ka
table hota hai — bas yahi wala data chahiye tracking ke liye.

App me pehle se hi "Upload AWB / Manifest" naam ka feature tha (Orders page
par) jo bilkul isi problem ke liye bana tha — "Meesho ke order sheet me AWB
nahi aata, alag se AWB file daalo" — lekin wo sirf .csv file accept karta
tha, PDF nahi. Ab wahi feature seedha aapki asli PDF bhi accept karta hai.

KYA BADLA
---------
"Upload AWB / Manifest" (Orders page) ab .csv ke saath-saath .pdf bhi
accept karta hai — koi alag button/jagah nahi, wahi ek dropzone dono lete
hai. PDF daaloge to app khud parse kar ke har courier page se Sub Order
No. + AWB + Courier nikal lega, aur apne system ke orders se match kar ke
seedha AWB/Courier save kar dega — bilkul waise hi jaise CSV se hota hai.
Agar kisi row ka order system me nahi mila, to wo row clearly "not found"
error ke saath dikhegi (silently skip nahi hogi), taaki aap dekh sako
kaunsa order pehle CSV se import karna baaki hai.

VERIFY KAISE KIYA
------------------
Aapki di hui 4 asli PDF me se do (Arvagam wali single-courier, aur KANJUSH
wali jisme Delhivery + Valmo dono the) le kar test kiya — disposable
practice database par real order banaye jo unhi Sub Order No se match
karte the, real app chalayi, real PDF upload ki:
  - Arvagam PDF: sahi order match hua, real AWB (VL0085520150842) aur
    courier (Valmo) seedha database me save hua — check kiya.
  - KANJUSH PDF (2 courier page, 3 rows): 3 me se 2 rows sahi match hui
    (Delhivery ka pura-numeric AWB, Valmo ka VL-wala AWB — dono sahi),
    teesri row (jo jaanbujh kar seed nahi ki thi) "not found" error ke
    saath saaf dikhi — koi crash nahi, koi silent drop nahi.
  - Dobara wahi PDF upload ki — duplicate nahi bana (safe hai).
  - Ek testing ke dauraan ek asli bug pakda: agar koi galat/corrupt file
    upload ho to app crash ho kar generic "Internal server error" deta
    tha — usko fix kiya, ab saaf error milega.
  - Purana .csv wala tarika bhi dobara test kiya — waisa hi kaam kar raha
    hai, kuch nahi bigda.
`npx tsc --noEmit`: 0 errors. Existing tests ke 3 purane (isse related
nahi) failures dobara confirm kiye.

FILES APPLY KAISE KARNI HAIN
------------------------------
GitHub par apne repo me:

  1. In 4 files ko REPLACE karo (edit -> pura content paste -> commit):
       - src/routes/orders.ts
       - public/app.html
       - public/app.js
       - package.json
       - package-lock.json
       (5 files, replace)

  2. Ek NAYI file CREATE karo (ye pehli baar bani hai, pehle se nahi thi):
       - src/ingestion/meeshoManifestPdf.ts
     GitHub par "src/ingestion" folder me jaake "Add file" -> "Create new
     file" -> naam "meeshoManifestPdf.ts" -> content paste karo -> commit.

  3. package.json/package-lock.json replace karne se ek nayi library
     ("pdf-parse") add ho jayegi jo PDF padhne ke liye chahiye — Vercel
     apne aap `npm install` karke isko deploy ke time install kar lega,
     kuch alag se karne ki zaroorat nahi.

(Agar git use karte ho: dono patch files "0001-..." aur "0002-..." ko
`git am` se order me apply kar sakte ho — sab files aur naya file dono
khud ban jayenge.)

Iske baad Vercel redeploy hoga, tab "Upload AWB / Manifest" me PDF
option live ho jayega.

AGE KE LIYE
-----------
Agar Meesho kabhi manifest ka format thoda badal de (jaise koi naya
courier partner ya column order alag ho), to bas is PDF ka example bhej
dena — parsing sirf yahi ek file (src/ingestion/meeshoManifestPdf.ts) me
hai, baaki kuch chhedne ki zaroorat nahi hogi.
