const TELEGRAM_LIMIT = 4096;

export class GoldTelegram {
  constructor({ telegramBotToken, telegramChatId }) {
    this.token = telegramBotToken;
    this.chatId = telegramChatId;
  }

  async send(text) {
    const body = new URLSearchParams({
      chat_id: this.chatId,
      text: String(text).slice(0, TELEGRAM_LIMIT),
      disable_web_page_preview: 'true',
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body,
        signal: controller.signal,
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) {
        throw new Error(`Telegram send failed: ${data?.description || `HTTP ${response.status}`}`);
      }
      return data.result;
    } finally {
      clearTimeout(timer);
    }
  }
}

