import { EventEmitter } from 'node:events';

export class SlackError extends Error {
  constructor(code, retryAfter = 0) { super(`Slack: ${code}`); this.code = code; this.retryAfter = retryAfter; }
}

export async function slackApi(method, token, body = {}, { fetchFn = fetch } = {}) {
  let response, data;
  try {
    response = await fetchFn(`https://slack.com/api/${method}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000), redirect: 'error',
    });
    if (response.status === 429) throw new SlackError('rate_limited', Math.max(1, Math.min(300, Number(response.headers.get('retry-after')) || 30)));
    if (!response.ok) throw new SlackError('http_error');
    data = await response.json();
  } catch (error) { if (error instanceof SlackError) throw error; throw new SlackError('connection_failed'); }
  if (!data?.ok) throw new SlackError(/^[a-z_]{1,60}$/.test(data?.error) ? data.error : 'request_failed');
  return data;
}

export function splitMessage(text, length = 3500) {
  const chars = Array.from(String(text));
  const parts = [];
  for (let i = 0; i < chars.length; i += length) parts.push(chars.slice(i, i + length).join(''));
  return parts.length ? parts : ['Done.'];
}

export class SlackConnection extends EventEmitter {
  constructor({ bot, teamId, env = process.env, api = slackApi, WebSocketClass = WebSocket, onEnvelope, allowedUserIds = [] }) {
    super();
    Object.assign(this, { bot, teamId, api, WebSocketClass, onEnvelope });
    if (!Array.isArray(allowedUserIds)) throw new SlackError('invalid_notification_allowlist');
    this.allowedUserIds = new Set(allowedUserIds);
    this.botToken = env[bot.botTokenEnv]; this.appToken = env[bot.appTokenEnv];
    this.stopped = true; this.reconnectAttempts = 0; this.botUserId = null;
  }

  async verify() {
    const identity = await this.api('auth.test', this.botToken);
    if (identity.team_id !== this.teamId || !identity.bot_id || !identity.user_id) throw new SlackError('wrong_workspace_or_not_bot');
    this.botUserId = identity.user_id;
    return { teamId: identity.team_id, botUserId: identity.user_id };
  }

  async start() { await this.verify(); this.stopped = false; await this.connect(); }

  async connect() {
    if (this.stopped) return;
    const result = await this.api('apps.connections.open', this.appToken);
    const url = new URL(result.url);
    if (url.protocol !== 'wss:' || !url.hostname.endsWith('.slack.com')) throw new SlackError('invalid_socket_url');
    if (this.stopped) return;
    const socket = new this.WebSocketClass(result.url);
    this.socket = socket;
    await new Promise((resolve, reject) => {
      let opened = false;
      const timeout = setTimeout(() => { socket.close(); reject(new SlackError('socket_timeout')); }, 20000);
      socket.addEventListener('open', () => {
        opened = true; clearTimeout(timeout); this.reconnectAttempts = 0; resolve(); this.emit('connected');
      });
      socket.addEventListener('message', event => {
        // Persist acceptance before acknowledgement; Slack retries unacknowledged envelopes.
        try {
          const message = JSON.parse(String(event.data));
          if (message.type === 'disconnect') { socket.close(); return; }
          if (!message.envelope_id) return;
          if (message.type === 'events_api') this.onEnvelope(message.payload, this);
          socket.send(JSON.stringify({ envelope_id: message.envelope_id }));
        } catch { this.emit('warning', 'A Slack delivery could not be saved; it may be retried.'); }
      });
      socket.addEventListener('error', () => { if (!opened) { clearTimeout(timeout); reject(new SlackError('socket_failed')); } socket.close(); });
      socket.addEventListener('close', () => {
        clearTimeout(timeout);
        if (!opened) reject(new SlackError('socket_closed'));
        if (opened && this.socket === socket && !this.stopped) this.scheduleReconnect();
      });
    });
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(60000, 1000 * 2 ** Math.min(this.reconnectAttempts++, 6));
    this.emit('warning', 'Slack disconnected. Reconnecting automatically.');
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try { await this.connect(); } catch { this.scheduleReconnect(); }
    }, delay);
  }

  async post({ channel, threadTs, text, id, notifyUserId = null }) {
    let mrkdwn = false;
    if (notifyUserId !== null) {
      if (typeof notifyUserId !== 'string' || !/^[UW][A-Z0-9]+$/.test(notifyUserId) || !this.allowedUserIds.has(notifyUserId)) {
        throw new SlackError('notification_user_not_allowed');
      }
      const body = String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      text = `<@${notifyUserId}>\n${body}`;
      mrkdwn = true;
    }
    return this.api('chat.postMessage', this.botToken, {
      channel, thread_ts: threadTs, text, client_msg_id: id,
      mrkdwn, parse: 'none', link_names: false, unfurl_links: false, unfurl_media: false,
    });
  }

  stop() { this.stopped = true; clearTimeout(this.reconnectTimer); this.reconnectTimer = null; this.socket?.close(); }
}
