# Yayındasın

Spikerlik ve sunuculuk eğitim uygulaması: Android + iOS (Capacitor 8) ve Express backend.

```
yayindasin/
├── app/                 Capacitor projesi
│   ├── www/             Uygulamanın kendisi (index.html, ses dosyaları, font)
│   │   ├── config.js    Backend adresi ve APP_KEY  ← yayından önce düzenle
│   │   └── platform.js  Backend, eğitmen sesleri ve native köprüleri (geri tuşu, paylaşma, durum çubuğu)
│   ├── android/         Android Studio projesi
│   ├── ios/             Xcode projesi
│   └── assets/          İkon ve açılış ekranı kaynakları
├── server/              Express API: yapay zekâ ara katmanı + eğitmen sesleri
└── render.yaml          Render Blueprint
```

## 1. Backend (Render + MongoDB Atlas)

1. **MongoDB Atlas'ta** ücretsiz bir küme aç ve bağlantı adresini al. Eğitmen sesleri GridFS'te durur; Render'ın diski her deploy'da silindiği için dosya diske yazılmaz.
2. Repoyu GitHub'a it. Render'da **New → Blueprint** deyip repoyu seç. `render.yaml` servisi kendisi kurar.
3. Ortam değişkenlerini gir:

| Değişken | Ne işe yarar |
|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com'dan alınır |
| `MONGODB_URI` | Atlas bağlantı adresi |
| `APP_KEY` | Uygulamaya gömülen ortak anahtar. Gelişigüzel kötüye kullanımı süzer; gerçek bir sır değildir. |
| `TRAINER_KEY` | Render otomatik üretir. Yalnızca eğitmenlere ver. |
| `MODEL_QUICK` / `MODEL_DEFAULT` | Çeviri için hızlı model, içerik üretimi için varsayılan model |
| `AI_PER_MINUTE` / `AI_PER_DAY` | IP başına sınır (varsayılan 30 / 400) |

4. `https://<servis>.onrender.com/health` adresi `{"ok":true,"ai":true,"storage":"mongodb"}` döndürmeli.

Yerelde çalıştırmak için: `cd server && cp .env.example .env && npm i && npm run dev`. Testler `npm test` ile çalışır. Testler sahte bir Anthropic sunucusu kullanır, API anahtarı gerekmez.

> Render'ın ücretsiz planı 15 dakika boşta kalınca uyur; ilk istek yaklaşık 50 saniye sürer. Bu sürede uygulama normal çalışır, yalnızca yapay zekâ düğmeleri geç belirir. Gerçek kullanıcı varsa Starter plan ($7/ay) bu gecikmeyi kaldırır.

## 2. Uygulama

```bash
cd app
npm install
# www/config.js içinde API_URL'i Render adresinle, APP_KEY'i sunucudakiyle aynı yap
npx cap sync
npm run android      # Android Studio açılır → Run
npm run ios          # yalnızca macOS + Xcode
```

- `www/` içinde bir şeyi değiştirdikten sonra `npx cap sync` çalıştır.
- İkonu değiştirmek için `assets/` içindeki PNG'leri değiştirip `npm run icons` de.
- `config.js` içinde `API_URL` boş bırakılırsa tamamen çevrimdışı bir sürüm çıkar: yapay zekâ ve paylaşılan eğitmen sesleri gizlenir, geri kalan her şey çalışır.

### Eğitmen modu
Profil → **Eğitmen girişi** alanına `TRAINER_KEY` yazılır. Bu modda karşılama sesi ve sokak görevi anlatımları kaydedilir ya da yüklenir; bütün öğrenciler aynı sesi duyar. Sunucuda kayıt yoksa uygulamayla gelen hazır anlatımlar çalar.

## 3. Mağazalar

- **Google Play:** Bir kerelik $25 geliştirici hesabı gerekir. Android Studio'da *Build → Generate Signed App Bundle* ile `.aab` üretilip yüklenir. Yeni kişisel hesaplarda yayından önce 12 test kullanıcısıyla 14 günlük kapalı test şartı var.
- **App Store:** Yıllık $99 Apple Developer üyeliği ve bir Mac gerekir. Xcode'da *Product → Archive → Distribute* izlenir.
- **Gizlilik politikası:** Mikrofon ve kamera kullanıldığı için iki mağaza da istiyor. Politikada şunlar yazmalı: kayıtlar cihazda kalır; yapay zekâ özellikleri, kullanıcının yazdığı metni (CV için ad ve özgeçmiş dahil) sunucu üzerinden Anthropic'e gönderir; eğitmen sesleri sunucuda saklanır. Play'deki *Data safety* formu da buna göre doldurulur.

## Claude.ai sürümüne göre değişenler

- `window.claude` (sample/db/assets/downloads) yerine `platform.js` ve kendi backend'in kullanılıyor; claude.ai dışında yaşanan 10 saniyelik bekleme yok.
- Gömülü base64 sesler `www/audio/*.mp3` dosyalarına ayrıldı (HTML 1,9 MB → 300 KB). Archivo fontu uygulamanın içinde geliyor.
- Yapay zekâ yanıtları HTML'e basılmadan önce temizleniyor (`<`, `>`, `"`).
- Gol anonsu ses gelmeyince artık kilitlenmiyor ve sessizliğe XP vermiyor.
- "İlerlemeyi sıfırla" eğitmen kayıtlarını silmiyor.
- localStorage dolarsa çeviri önbellekleri boşaltılıp ilerleme yine kaydediliyor.
- CV telefonda paylaşma menüsüyle dışa aktarılıyor, dosya adı Türkçe karakter içermiyor. Android'de geri tuşu önce açık ekranı kapatıyor.
