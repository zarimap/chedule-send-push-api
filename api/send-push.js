import webpush from 'web-push';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const {
    SUPABASE_URL,
    SUPABASE_SECRET_KEY,
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  } = process.env;

  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return res.status(500).json({ error: 'Missing environment variables' });
  }

  webpush.setVapidDetails(
    'mailto:admin@maps.zaritsuri.com',
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );

  try {
    const {
      title = '科学部 予定管理',
      body = '',
      url = 'https://maps.zaritsuri.com/schedule/',
      targetUsers = null, // null または ['all'] なら全員、['太郎', '花子'] なら該当者のみ
      excludeUser = null  // 送信者本人を除外する場合に指定
    } = req.body || {};

    // Supabase から購読一覧を取得（新APIキーのため apikey ヘッダのみ使用）
    const supaRes = await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?select=*`, {
      method: 'GET',
      headers: {
        'apikey': SUPABASE_SECRET_KEY
      }
    });

    if (!supaRes.ok) {
      const errText = await supaRes.text();
      return res.status(supaRes.status).json({ error: 'Supabase fetch failed', detail: errText });
    }

    const subscriptions = await supaRes.json();

    // 送信対象の絞り込み
    const targets = subscriptions.filter((sub) => {
      if (excludeUser && sub.user_name === excludeUser) return false;
      if (!targetUsers || targetUsers.includes('all')) return true;
      return sub.user_name && targetUsers.includes(sub.user_name);
    });

    const payload = JSON.stringify({ title, body, url });
    let sentCount = 0;
    const expiredEndpoints = [];

    await Promise.all(
      targets.map(async (sub) => {
        const pushSub = {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.p256dh,
            auth: sub.auth
          }
        };
        try {
          await webpush.sendNotification(pushSub, payload);
          sentCount++;
        } catch (err) {
          if (err.statusCode === 404 || err.statusCode === 410) {
            expiredEndpoints.push(sub.endpoint);
          } else {
            console.error('Push error:', err.statusCode || err.message);
          }
        }
      })
    );

    // 無効になった購読情報を削除
    await Promise.all(
      expiredEndpoints.map((ep) =>
        fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(ep)}`, {
          method: 'DELETE',
          headers: {
            'apikey': SUPABASE_SECRET_KEY
          }
        })
      )
    );

    return res.status(200).json({ ok: true, count: sentCount, cleaned: expiredEndpoints.length });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
