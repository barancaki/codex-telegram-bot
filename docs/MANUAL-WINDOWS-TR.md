# Elle açılan Windows kurulumu

Bot yalnız **Codex Telegram Başlat** kısayoluna bastığında çalışır. **Durdur**,
bu kurulumun doğrulanmış Node sürecini ve onun alt süreçlerini durdurur.
Bilgisayar açılışında otomatik başlatma, servis, Windows görevi, otomatik
güncelleme, yeniden başlatma ve zamanlanmış prompt çalıştırma kurulmaz.

1. Node.js 20+ ve giriş yapılmış Codex CLI gerekir. Depoda `npm ci --ignore-scripts`
   çalıştır. Bu kurulum native PTY derleme betiğini çalıştırmaz; normal mesaj
   akışı Codex app-server kullanır.
2. Kısayolları gerçek masaüstüne oluştur:
   `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/manual.ps1 -Action Shortcuts -Workspace "VAULT_YOLU" -DevelopmentRoot "DEVELOPMENT_YOLU"`
3. **Codex Telegram Ayarlar** ile BotFather tokenını ve **kendi sayısal Telegram
   kullanıcı ID'ni** yerel pencerede gir. Token maskelenir; sohbete veya komut
   satırına yazman gerekmez. Boş giriş mevcut değeri korur. `.env` Git'e girmez.
4. **Başlat** ile aç, **Durdur** ile kapat. Yeniden açmak için yine Başlat gerekir.
   Başlat token ve izinli kullanıcı listesi eksik/geçersizse Codex'i açmaz.

Yerel `.env` içinde `CODEX_WORKSPACE` varsayılan klasörü, `PROJECT_ROOTS`
proje listesinin köklerini belirtir. Başlat güvenli ayarları zorunlu kılar:
`CODEX_TRUST_ALL_TOOLS=false`, `AUTO_UPDATE=false`, `ACP_AUTO_RESTART=false`,
`SCHEDULED_TASKS=false`. Codex workspace-write sandbox ile çalışır ve gerekli
işlemlerde Telegram üzerinden onay ister. Onay iletilemezse işlem reddedilir.
Mevcut Codex oturumu/auth dosyaları değiştirilmez.

`CODEX_CLI_PATH` boşsa Windows'ta açık Codex masaüstü uygulamasının kendi
binary'si seçilir; uygulama kapalıysa son yerel masaüstü binary'si, yoksa PATH
kullanılır. Açık bir `CODEX_CLI_PATH` bu seçimi geçersiz kılar. Masaüstü
güncellemesinden sonra botu Durdur/Başlat ile yeniden aç.

`/sohbet <başlık parçası>` kayıtlı sohbetleri başlıkla bulur; `/sessions`
sayfalı seçiciyi açar. Model ve Reasoning menüleri her açılışta canlı Codex
kataloğunu yeniler. `/models` sürümü ve desteklenen native effort değerlerini
gösterir; `/model <id>` aynı doğrulanmış seçimi uygular. Reasoning seçimi
`turn/start.effort` ile gönderilir. Sürdürülen sohbetin modeli ve effort'u
korunur; başka sohbetin seçimi onu değiştirmez. Masaüstünün özel araçları ve
eklenti arayüzü bu bağımsız app-server bağlantısına otomatik taşınmaz.

Durum: `npm run manual:status`. Kısayoldan başlangıç hatası bir ileti kutusunda
görünür. Sonraki çalışma hataları `logs/manual/stderr.log` ve
`logs/manual/bot.log` içindedir; stdout `logs/manual/stdout.log` dosyasına gider.
Veri `data/manual/` altında tutulur. Bu dosyalar Git'e girmez; konuşma/işlem
ayrıntısı içerebilir. Durdur devam eden işi zorla keser; önce Telegram Stop ile
turnü iptal etmek daha temizdir.

Kontroller: `npm run typecheck`, `npm test`,
`powershell -NoProfile -File scripts/manual.ps1 -Action SelfTest`.
`node --import tsx scripts/smoke-local.ts [thread-id]` yalnız Codex bağlantısını
ve kaydedilmiş oturum görünürlüğünü, seçilen binary'yi ve canlı model/effort
listesini kontrol eder; prompt göndermeden kapanır.
Kaydedilmiş masaüstü sohbeti görünür olabilir; uygulamada hâlen çalışıyor
olduğunu bu depo diskten tespit edemez. Oturum sürdürmek mevcut sohbetle aynı
anda yazışma riskini taşır.

Tek örnek kilidi canlı bir PID gördüğünde açılışı reddeder; hiçbir eski süreci
öldürmez. Nadir bir çökmede `.lock.reclaim` dosyası kalırsa hata tam yolu
gösterir. Dosyayı yalnız ilgili botun kapalı olduğunu doğruladıktan sonra sil.
