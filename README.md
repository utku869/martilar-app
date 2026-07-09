# Martılar — Sahne Defteri

Grup provası için tab/nota görüntüleme, metronom, mikrofonlu pratik puanı, MIDI içe aktarma ve senkron stüdyo odası uygulaması.

## Telefonda çalıştırmak

### Yol 1 — Vercel'e sürükle-bırak (en kolay, önerilen)

1. [vercel.com](https://vercel.com) hesabı aç (ücretsiz).
2. Bu klasörde bir kez `npm install` ve `npm run build` çalıştır → `dist/` klasörü oluşur.
3. Vercel panelinde **Add New → Project → Deploy** ile `dist` klasörünü sürükle-bırak,
   ya da bu klasörü GitHub'a push edip Vercel'e bağla (otomatik build alır).
4. Vercel bir adres verir (ör. `martilar.vercel.app`). Telefonda o adresi aç.

### Yol 2 — Yerelde test

```bash
npm install
npm run dev
```

Terminalde çıkan adresi (ör. `http://localhost:5173`) telefonun aynı Wi-Fi'daysa
bilgisayarının IP'siyle açabilirsin: `http://192.168.x.x:5173`.

## Ana ekrana ekleme (uygulama gibi)

- **iPhone (Safari):** Paylaş → "Ana Ekrana Ekle"
- **Android (Chrome):** ⋮ menü → "Ana ekrana ekle"

PWA olarak kurulur; tam ekran açılır, çevrimdışı da çalışır.

## Notlar

- **Kayıtlar** `localStorage`'da tutulur — şarkılar ve MIDI'ler cihazda kalıcıdır.
- **Mikrofon** (pratik modu) HTTPS gerektirir; Vercel adresleri otomatik HTTPS'tir,
  yerel testte `localhost` sorun çıkarmaz ama IP ile açarken mikrofon çalışmayabilir.
- **Stüdyo Odası:** Bu sürümde oda senkronu `localStorage` tabanlıdır; yani yalnızca
  **aynı cihaz/tarayıcıda** test edilir. Gerçek çok-cihazlı senkron için küçük bir
  backend (Firebase/Supabase Realtime) bağlanması gerekir — kod bunun için hazır,
  sadece `storage` sarmalayıcısını gerçek bir paylaşımlı API'ye yönlendirmen yeterli.
