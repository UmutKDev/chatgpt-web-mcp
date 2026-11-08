# Araştırma notları (Kasım 2026)

## İncelenen projeler

| Proje | Yaklaşım | Taşıma | Öne çıkan fikirler | Eksikler |
| --- | --- | --- | --- | --- |
| leixyou/chatgpt-web-image-mcp | ChatGPT web, Playwright, ayrı Chrome profili | stdio | Karakter ve stil profilleri, ChatGPT Project kurulumu, `/images` yüzeyi, işleri sıraya koyma, girdi klasörü beyaz listesi, temizlenmiş hata mesajları, MIME doğrulaması | Yalnız yerel, oturum env ile verilemiyor, uzun işlerde istemci zaman aşımı |
| lownamlee/gpt-image-2-mcp | `chatgpt-web`, `api` ve `auto` backend'leri | stdio | Sohbete devam (`conversation_mode`), ret metni algılama, hata anında ekran görüntüsü, pencereyi gizleme | Tek dosyada 1.200 satır tarayıcı mantığı, sunucu dağıtımı yok |
| nothariharan/image-gen | Edge/Chrome CDP | stdio | Ajanın aracı seçmesi için skill dosyası, kuyruk, şeffaflık sonrası işleme | Windows odaklı |
| agentify-sh/desktop | Masaüstü uygulaması, birden fazla sohbet sitesi | stdio | Paralel gizli sekmeler, dosya yükleme ve indirme | Görsele özel değil |
| Borys520/gpt-image-2-mcp | OpenAI Images API | stdio | Düzenleme oturumları, boyut ön doğrulaması, maliyet tahmini, `structuredContent` | API ücretli |
| strato-space/media-gen-mcp | OpenAI ve Google API | stdio | `resource_link` çıktısı, sıkıştırma, sonuç yerleşimi ayarı | API ücretli |
| lansespirit/image-gen-mcp, shinpr/mcp-image | Çoklu sağlayıcı API | stdio/HTTP | İstemi zenginleştirme, kalite ön ayarları | API ücretli |

## Bu projede birleştirilenler

- Web oturumu yaklaşımı (leixyou, lownamlee), ama oturum env değişkeniyle verilir. Böylece konteynerde ve Obot'ta çalışır.
- Streamable HTTP ve stdio birlikte. Obot konteyner çalışma zamanı Streamable HTTP ister.
- Uzun işler için kuyruk, ilerleme bildirimleri ve `get_job` ile asenkron sonuç.
- Sohbet içinde yineleme (`refine_image`) ve varyasyonlar (Borys520'deki düzenleme oturumlarının web karşılığı).
- Karakter ve stil profilleri, referans görsellerle birlikte (leixyou).
- Ret, limit ve soru cevaplarını ayrı hata kodlarına çevirme, hata anında ekran görüntüsü (lownamlee).
- Satır içi görsel, `resource_link` ve imzalı indirme bağlantısı (strato-space).
- Seçicilerin env ile güncellenebilmesi. ChatGPT arayüzü sık değiştiği için kod değişikliği gerektirmez.

## Obot gereksinimleri

- Çalışma zamanı: `containerized` (üretim için önerilen). İmaj, port ve Streamable HTTP yolu (`/mcp`) gerekir.
- Gizli değerler `env` altında `sensitive: true` alanlar olarak tanımlanır. vMCP'ye eklerken "Provided at connection" seçilirse her kullanıcı kendi değerini girer.
- GitOps ile katalog: tek dosyada tek sunucu, `name`, `description`, `runtime`, `containerizedConfig`, `env`, `toolPreview`, `resources`.
- Kaynak: [obot-platform/mcp-catalog](https://github.com/obot-platform/mcp-catalog) ve Obot dokümanlarındaki "Add hosted MCP servers" ile "MCP server GitOps" sayfaları.
