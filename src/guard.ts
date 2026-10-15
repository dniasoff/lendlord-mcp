export interface GuardConfig {
  readOnly: boolean;
  autoConfirm: boolean;
}

export type GuardResult = { ok: true } | { ok: false; message: string };

/**
 * Write confirmation is required once per MCP session: the first write is
 * rejected with an explanation, and once the user confirms (confirm: true),
 * every later write in the same session goes through.
 */
export class WriteGuard {
  private confirmed: boolean;

  constructor(private readonly config: GuardConfig) {
    this.confirmed = config.autoConfirm;
  }

  get unlocked(): boolean {
    return this.confirmed && !this.config.readOnly;
  }

  check(action: string, confirm: boolean | undefined): GuardResult {
    if (this.config.readOnly) {
      return {
        ok: false,
        message: `Refused: "${action}" changes Lendlord data and this server runs with LENDLORD_READ_ONLY=true.`,
      };
    }
    if (this.confirmed) return { ok: true };
    if (confirm) {
      this.confirmed = true;
      return { ok: true };
    }
    return {
      ok: false,
      message:
        `Confirmation needed: "${action}" will change data in the user's Lendlord account. ` +
        "Ask the user to approve write access for this session, then call this tool again with confirm: true. " +
        "After that, other writes in this session will not need confirmation.",
    };
  }
}
