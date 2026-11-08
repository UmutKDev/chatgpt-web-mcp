# chatgpt-web-mcp

ChatGPT hesabınla görsel üreten, düzenleyen ve aynı sohbet içinde yineleyen bir MCP sunucusu. OpenAI API'si yerine giriş yapılmış ChatGPT web oturumunu Playwright ile sürer. Streamable HTTP ve stdio konuşur, Docker imajıyla gelir ve [Obot MCP Gateway](https://github.com/obot-platform/obot) üzerinde konteyner olarak çalışacak şekilde hazırlanmıştır.

> [!WARNING]
> Bu proje OpenAI'ın resmî bir entegrasyonu değildir. ChatGPT web arayüzünü otomatikleştirmek [OpenAI Kullanım Koşulları](https://openai.com/policies/terms-of-use/) ile çelişebilir ve hesabın kısıtlanmasına yol açabilir. ChatGPT sayfası değiştiğinde seçiciler bozulabilir. Hesabını nasıl kullandığın senin sorumluluğundadır.

## Neler yapabilir

| Araç | Ne yapar |
| --- | --- |
| `generate_image` | Metinden görsel üretir. En-boy oranı, stil hazır ayarı, görselde birebir yazılacak metin, kaçınılacaklar, şeffaf arka plan, referans görseller, birden fazla görsel ve var olan sohbete devam desteklenir. |
| `edit_image` | Yüklenen görseli talimatla düzenler. İlk görsel düzenlenir, diğerleri referans olur. |
| `refine_image` | Görseli üreten ChatGPT sohbetinin içinde yineleme yapar ("gökyüzünü turuncu yap"). Ardışık düzenlemelerde en tutarlı yol budur. |
| `create_variations` | Bir görselin farklı versiyonlarını üretir. |
| `get_job`, `list_jobs`, `cancel_job` | Uzun süren işleri arka planda izler, bekler ya da iptal eder. |
| `list_images`, `get_image`, `tag_image`, `delete_image` | Görsel kütüphanesini yönetir. Her görsel istemi ve sohbetiyle saklanır. |
| `list_conversations` | Sunucunun görsel ürettiği ChatGPT sohbetlerini listeler. |
| `save_profile`, `list_profiles`, `delete_profile` | Tutarlı karakter ve stil profilleri. Referans görsel id'leri her istekte otomatik yüklenir. |
| `list_style_presets` | Hazır stiller: photorealistic, cinematic, product-shot, logo, icon, anime, pixel-art ve diğerleri. |
| `check_session` | ChatGPT girişinin çalışıp çalışmadığını söyler, istenirse ekran görüntüsü döndürür. |
| `get_server_status` | Kuyruk, depolama ve limit özeti. |

Ayrıca her görsel `image://<id>` MCP kaynağı olarak okunabilir. `image_brief` istemi kaba bir fikri ayrıntılı bir görsel istemine çevirir.

**Sonuç biçimi:** Araçlar görseli satır içi (`image` içeriği), `resource_link` ve JSON özet olarak döndürür. `PUBLIC_BASE_URL` tanımlıysa imzalı ve süreli bir indirme bağlantısı da eklenir.

**Uzun işler:** Bir görsel genelde 30 ile 120 saniye sürer. Araç `SYNC_WAIT_SECONDS` kadar bekler ve bu sırada MCP ilerleme bildirimleri gönderir. İş daha uzun sürerse bir `job_id` döner. İstemci sonucu `get_job` ile alır. `wait: false` ile iş hemen arka plana atılır.

## Nasıl çalışır

```text
MCP istemcisi ── Streamable HTTP (/mcp) ya da stdio ──► chatgpt-web-mcp
                                                         │  iş kuyruğu (tek sıra)
                                                         ▼
                                       Chromium (Xvfb üzerinde, Playwright)
                                                         │  oturum çerezlerin
                                                         ▼
                                                    chatgpt.com
                                                         │
                     görsel kimlik doğrulamalı fetch ile indirilir ──► /data/outputs + kütüphane
```

Sunucu istemi ChatGPT'nin giriş kutusuna yazar, gönderir ve asistanın cevabındaki yeni görselleri bekler. ChatGPT işlerken gösterdiği bulanık ön izlemeyi atlar, durdur düğmesi kaybolup görsel sabitlenince indirir. Asistan görsel yerine metinle cevap verirse (içerik reddi, kullanım limiti, soru) bunu `CONTENT_REFUSED`, `RATE_LIMITED` ya da `NO_IMAGE_RETURNED` hatasına çevirir ve sohbet kimliğini döndürür.

## Hızlı başlangıç

### 1. ChatGPT oturumunu dışa aktar

Kendi bilgisayarında (Chrome kurulu olmalı):

```bash
git clone https://github.com/UmutKDev/chatgpt-web-mcp.git
cd chatgpt-web-mcp
npm install
npm run export-session
```

Açılan ayrı bir tarayıcı profilinde ChatGPT'ye giriş yap. Giriş kutusu görününce betik `chatgpt-session.json` dosyasını yazar ve ekrana tek satırlık bir base64 değer basar. Bu değer `CHATGPT_SESSION_STATE` olarak kullanılır. Bir şifre gibi sakla ve repoya koyma.

Daha kısa bir yol olarak tarayıcının geliştirici araçlarından `__Secure-next-auth.session-token` çerezinin değerini `CHATGPT_SESSION_TOKEN` olarak verebilirsin. Tam oturum (Cloudflare çerezleri dahil) daha az doğrulama ekranına takılır.

### 2. Docker ile çalıştır

```bash
docker run --rm -p 8099:8099 --shm-size=1g \
  -e CHATGPT_SESSION_STATE="$(base64 -w0 chatgpt-session.json)" \
  -e MCP_AUTH_TOKEN=degistir \
  -v chatgpt-data:/data \
  ghcr.io/umutkdev/chatgpt-web-mcp:latest
```

ya da `docker compose up -d` (değerleri `.env` dosyasından okur).

### 3. MCP istemcisine bağla

HTTP (Claude Code örneği):

```bash
claude mcp add --transport http chatgpt-image http://localhost:8099/mcp \
  --header "Authorization: Bearer degistir"
```

stdio (yerel, Docker olmadan):

```json
{
  "mcpServers": {
    "chatgpt-image": {
      "command": "npx",
      "args": ["-y", "github:UmutKDev/chatgpt-web-mcp", "--stdio"],
      "env": { "CHATGPT_SESSION_STATE": "/mutlak/yol/chatgpt-session.json", "HEADLESS": "false" }
    }
  }
}
```

## Obot'a yayına alma

Obot, üretim için konteyner çalışma zamanını önerir. Konteynerin Streamable HTTP sunması, kataloğa da imaj, port ve yolun yazılması gerekir. Bu repo bunların hepsini hazır getirir.

1. **İmajı yayımla.** `main`'e her push ve her `v*` etiketi `.github/workflows/docker.yml` ile `ghcr.io/umutkdev/chatgpt-web-mcp` imajını amd64 ve arm64 için üretir. GHCR paketini Obot'un çekebilmesi için public yap ya da Obot'a registry erişimi ver. Üretimde imajı digest ile sabitle.
2. **Katalog girdisini ekle.** İki yol var:
   - **GitOps:** Obot'ta *MCP Servers → Catalog sources* altına bu reponun URL'sini ekle. Katalog dosyası [`obot/chatgpt-web-image.yaml`](obot/chatgpt-web-image.yaml) içinde. Kök dizindeki `.obotcatalogs` yalnız bu klasörü okutur.
   - **Arayüzden:** *Add MCP Server → Hosted Server → Containerized* seç. Image `ghcr.io/umutkdev/chatgpt-web-mcp:0.1.0`, Port `8099`, Path `/mcp` gir. `CHATGPT_SESSION_STATE` ve `CHATGPT_SESSION_TOKEN` alanlarını **Sensitive** olarak tanımla.
3. **Kullanıcı türü.** Girdi `serverUserType: singleUser` olarak gelir. Her kullanıcı kendi konteynerini ve kendi ChatGPT oturumunu alır. Böylece kuyruklar ve hesap limitleri birbirine karışmaz. Tek bir paylaşılan hesap istiyorsan girdiyi `multiUser` yap ve oturumu sunucu düzeyinde ver.
4. **vMCP'ye ekle.** Girdiyi bir vMCP'ye eklerken oturum alanları için **Provided at connection** seç. Her kullanıcı bağlanırken kendi değerini girer.
5. **Kaynaklar.** Chromium için en az 1 GiB bellek gerekir. Katalog girdisi 500m CPU ve 1 GiB bellek ister, 2 CPU ve 3 GiB bellekle sınırlar.

Obot konteyneri yeniden başlatırsa `/data` silinebilir. Oturum yine env değerinden açılır. Ancak kütüphanedeki görseller ve profiller kaybolur. Kalıcı olmaları gerekiyorsa bağımsız Kubernetes kurulumunu ([`deploy/kubernetes`](deploy/kubernetes/chatgpt-web-mcp.yaml)) PVC ile kullan ve Obot'a **remote** sunucu olarak ekle.

## Yapılandırma

| Değişken | Varsayılan | Açıklama |
| --- | --- | --- |
| `CHATGPT_SESSION_STATE` | | `export-session` çıktısı. Base64, düz JSON, dosya yolu ya da çerez eklentisi JSON dizisi olabilir. |
| `CHATGPT_SESSION_TOKEN` | | `__Secure-next-auth.session-token` değeri. Parçalı çerezler için `parca0\|parca1`, birden fazla çerez için `ad=deger; ad2=deger2` biçimi de kabul edilir. |
| `PERSIST_SESSION` | `true` | Yenilenen çerezleri `/data` altına yazar. Env değeri değişirse yeni değer kazanır. |
| `CHATGPT_PROFILE_DIR` | | Geçici bağlam yerine kalıcı bir Chromium profili kullanır. |
| `CHATGPT_CDP_URL` | | Tarayıcı başlatmak yerine var olan bir Chrome'a bağlanır. Uzak adresler için `ALLOW_REMOTE_CDP=true` gerekir. |
| `CHATGPT_DEFAULT_URL` | `https://chatgpt.com/` | Yeni sohbetlerin açılacağı adres, örneğin bir ChatGPT Project ya da GPT. |
| `MCP_TRANSPORT` | `http` | `http` ya da `stdio`. `--stdio` argümanı da çalışır. |
| `PORT`, `HOST`, `MCP_PATH` | `8099`, `0.0.0.0`, `/mcp` | HTTP dinleme ayarları. |
| `MCP_AUTH_TOKEN` | | Tanımlıysa `/mcp` için `Authorization: Bearer` ister. Obot zaten kimlik doğruladığı için orada gerekmez. |
| `PUBLIC_BASE_URL` | | İmzalı `/files/<id>` indirme bağlantılarını açar. |
| `HEADLESS` | `false` | Docker imajı Xvfb ile görünür modda çalışır. Görünmez mod daha sık doğrulamaya takılır. |
| `BROWSER_PROXY_SERVER`, `_USERNAME`, `_PASSWORD` | | Tarayıcı vekil sunucusu. |
| `BROWSER_LOCALE`, `BROWSER_TIMEZONE`, `BROWSER_USER_AGENT` | `en-US`, `UTC` | Tarayıcı parmak izi. Hesabının bölgesine yakın değerler seç. |
| `BROWSER_CHANNEL`, `BROWSER_EXECUTABLE_PATH` | | Belirli bir Chrome ya da Chromium kullanır. |
| `GENERATION_TIMEOUT_SECONDS` | `300` | Tek bir görsel için en uzun bekleme. |
| `SYNC_WAIT_SECONDS` | `45` | Araç çağrısının sonucu beklediği süre. Sonra `job_id` döner. Claude gibi istemciler araç çağrısını 60 saniyede kestiği için bu değeri 60 saniyenin altında tut. |
| `MAX_IMAGES_PER_JOB` | `4` | `count` üst sınırı. |
| `MAX_CONCURRENT_JOBS` | `1` | Aynı anda çalışan sekme sayısı (en fazla 4). |
| `MAX_QUEUE_LENGTH` | `20` | Bekleyen iş sınırı. |
| `MAX_INPUT_IMAGES`, `MAX_INPUT_IMAGE_BYTES` | `8`, 20 MiB | Girdi görsel sınırları. |
| `ALLOW_URL_INPUTS` | `true` | https görsel adreslerini indirir. Özel ağ adresleri her zaman engellenir. |
| `ALLOWED_INPUT_DIRS` | | Yerel dosya girdilerine izin verilen klasörler. Boşsa yerel dosya okunmaz. |
| `RETURN_MODE` | `both` | `both`, `image` ya da `link`. |
| `INLINE_MAX_BYTES` | 4 MiB | Satır içi döndürülen görsellerin toplam boyut sınırı. |
| `RETENTION_DAYS`, `MAX_STORAGE_MB` | `14`, `2048` | Kütüphane temizliği. `0` sınırı kapatır. |
| `CHATGPT_SELECTORS_JSON` | | ChatGPT arayüzü değiştiğinde seçicileri yeniden yazmadan günceller. Anahtarlar için [`src/browser/selectors.ts`](src/browser/selectors.ts) dosyasına bak. |
| `DIAGNOSTICS` | `true` | Hata anında ekran görüntüsü saklar (`check_session` ile `last_error_screenshot`). |
| `LOG_LEVEL` | `info` | Loglar stderr'e JSON olarak yazılır. Çerez ve token alanları maskelenir. |

## Sorun giderme

| Hata kodu | Anlamı ve çözümü |
| --- | --- |
| `LOGIN_REQUIRED` | Oturum yok ya da süresi dolmuş. `npm run export-session` ile yenisini al. |
| `BLOCKED_BY_CHALLENGE` | ChatGPT "insan mısın" doğrulaması gösterdi. Tam oturumu kullan, `HEADLESS=false` bırak, hesabının ülkesinde bir konut vekil sunucusu dene ya da `CHATGPT_CDP_URL` ile gerçek bir Chrome'a bağlan. |
| `RATE_LIMITED` | Planının görsel limiti doldu. ChatGPT'nin verdiği süreyi bekle. |
| `CONTENT_REFUSED` | İçerik politikası reddi. İstemi yeniden yaz. |
| `NO_IMAGE_RETURNED` | ChatGPT metinle cevap verdi, örneğin bir soru sordu. Mesajı oku ve `refine_image` ile aynı sohbette cevapla. |
| `GENERATION_TIMEOUT` | Görsel süresinde gelmedi. Görsel yine de sohbette belirebilir. |
| `SEND_FAILED` | İstem yazıldı ama ChatGPT gönderimi almadı. Sunucu üç farklı yolla dener. Yine olmazsa `check_session` aracını `last_error_screenshot: true` ile çalıştır. |
| `NAVIGATION_FAILED` | Giriş kutusu bulunamadı. `check_session` ile `screenshot: true` çalıştır. Arayüz değiştiyse `CHATGPT_SELECTORS_JSON` ile seçicileri güncelle. |

## Geliştirme

```bash
npm install
npx playwright-core install chromium   # testler için
npm run typecheck
npm test            # birim testleri + sahte ChatGPT sayfasına karşı uçtan uca testler
npm run mock        # sahte ChatGPT'yi 8787'de elle denemek için
```

Uçtan uca testler [`test/mock/server.ts`](test/mock/server.ts) içindeki sahte ChatGPT sayfasına karşı çalışır. Bu sayfa giriş kutusunu, gönder ve durdur düğmelerini, dosya yüklemeyi, bulanık ön izlemeyi, `/c/<id>` sohbet adreslerini ve çerezle korunan görsel indirmeyi taklit eder. Gerçek chatgpt.com'a karşı otomatik test yoktur, çünkü hesap ve kota gerektirir.

## Güvenlik

- Tarayıcı yalnız `https://chatgpt.com` adresine yönlendirilir. Test dışında başka bir adres reddedilir.
- Oturum çerezleri loglara ve araç çıktılarına yazılmaz. Kalıcı oturum dosyası `0600` izinle saklanır.
- URL girdileri özel ve yerel ağ adreslerine gidemez. Yerel dosyalar yalnız `ALLOWED_INPUT_DIRS` içinden okunur ve sembolik bağlantılar çözülerek kontrol edilir.
- İndirme bağlantıları HMAC ile imzalanır ve 7 gün sonra geçersiz olur.
- Konteyner root olmayan `node` kullanıcısıyla çalışır. İmajda yalnız Chromium, Xvfb ve az sayıda font var.

## Esinlenilen projeler

Tasarım; [leixyou/chatgpt-web-image-mcp](https://github.com/leixyou/chatgpt-web-image-mcp), [lownamlee/gpt-image-2-mcp](https://github.com/lownamlee/gpt-image-2-mcp), [nothariharan/image-gen](https://github.com/nothariharan/image-gen), [Borys520/gpt-image-2-mcp](https://github.com/Borys520/gpt-image-2-mcp) ve [strato-space/media-gen-mcp](https://github.com/strato-space/media-gen-mcp) projelerinin incelenmesiyle şekillendi. Karşılaştırma için [docs/research.md](docs/research.md) dosyasına bak.

## Lisans

MIT
