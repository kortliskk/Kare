# KARE — Film & Dizi Takip

KARE, sunucu kiralamadan yayınlanabilen statik bir web uygulamasıdır. Ön yüz GitHub Pages, hesap ve veritabanı Supabase, afiş/bilgi kaynağı TMDB ile çalışır.

## Neler var?
- Üye olmadan aynı tarayıcıda misafir arşivi (localStorage).
- Supabase Auth ile e-posta/şifre hesabı; giriş yapan kullanıcıya özel bulut arşivi.
- Supabase Row Level Security (RLS): kullanıcı yalnızca kendi kayıtlarını okuyabilir/değiştirebilir/silebilir.
- Misafir listesini kayıt/giriş sırasında hesaba aktarma.
- Film/dizi ekleme, sezon/bölüm alt içerikleri, izleme durumu ve sezon/bölüm ilerlemesi.
- TMDB ve IMDb URL'lerinden TMDB üzerinden metadata/afiş alma; manuel ekleme.
- Mobil uyumlu mevcut KARE arayüzü.

## 1. Supabase kurulumu (ücretsiz katmanla başlayabilirsin)
1. Supabase'de yeni bir proje oluştur.
2. Project Settings → API bölümünden Project URL ve `anon`/publishable public key değerini al. `service_role` anahtarını ASLA kullanma veya siteye koyma.
3. SQL Editor'de `supabase/schema.sql` dosyasının tamamını çalıştır.
4. Authentication → URL Configuration bölümünde Site URL ve Redirect URLs alanlarına yayın adresini ekle (ör. `https://KULLANICI.github.io/KARE/`). Yerel test için `http://localhost:5500` eklenebilir.
5. İstersen Authentication → Providers → Email içinden e-posta doğrulamasını açık tut. Doğrulama açıkken kayıt sonrası gelen e-postadaki bağlantıya tıklanması gerekir.

## 2. TMDB anahtarı (otomatik afiş için)
TMDB API anahtarı alıp `config.js` içindeki `tmdbApiKey` alanına yaz. Manuel ekleme için TMDB anahtarı gerekmez. TMDB anahtarı tarayıcıda kullanılacağı için gizli kabul edilmemelidir; kullanımını TMDB panelinden sınırlandır ve koşullarına uy.

## 3. Yapılandırma
`config.js` dosyasındaki üç alanı doldur:
```js
window.KARE_CONFIG = {
  supabaseUrl: 'https://....supabase.co',
  supabaseAnonKey: 'SUPABASE_PUBLIC_ANON_KEY',
  tmdbApiKey: 'TMDB_API_KEY'
};
```
Burada yalnızca Supabase public anon/publishable key bulunmalı. `service_role`, veritabanı parolası veya özel anahtar koyma.

## 4. GitHub Pages ile yayınlama
1. Projeyi GitHub deposuna yükle.
2. `Settings → Pages` bölümünde `Deploy from a branch` seç.
3. Branch `main`, folder `/public` seç ve kaydet. (İstersen `public` klasörünün içeriğini kök dizine alarak root yayın da yapabilirsin.)
4. Site URL'sini Supabase Auth URL Configuration listesine ekle.

GitHub Pages'te `/public` klasörünü yayınlamak desteklenmiyorsa `public` içindeki dosyaları deponun köküne taşı ve Pages kaynağını `/ (root)` seç.

## Misafir ve senkronizasyon
Misafir arşivi yalnızca o tarayıcıda saklanır; başka cihazlara otomatik geçmez. Hesap açıp doğrulama/giriş tamamlandığında mevcut misafir kayıtları bulut hesabına aktarılır. Hesapla giriş yapınca aynı arşiv diğer cihazlarda görünür.

## Güvenlik ve oturum notu — önemli
Bu sürüm kendi backend sunucusu olmadan, Supabase'in yönetilen Auth servisini kullanır. Supabase JS tarayıcı oturumunu SDK'nın varsayılan güvenli depolamasında yönetir; statik GitHub Pages uygulaması kendi başına `HttpOnly` sunucu çerezi üretemez. Gerçek `HttpOnly; Secure; SameSite` çerezi zorunluysa ayrıca yönetilen SSR/edge katmanı gerekir. Burada kullanıcı verilerinin güvenliği esas olarak Supabase Auth + RLS politikalarıyla sağlanır. Tarayıcı tarafında saklanan public anahtar gizli değildir; RLS olmadan güvenli değildir.

## Yerel önizleme
Proje klasörünü herhangi bir statik dosya sunucusuyla açabilirsin (ör. VS Code Live Server). `file://` üzerinden açma; Auth yönlendirmeleri ve CDN modülleri için http/https kullan.

## TMDB atıfı
Bu ürün TMDB API kullanır ancak TMDB tarafından onaylanmamış veya sertifikalandırılmamıştır. TMDB'nin güncel API kullanım şartlarına uy.
