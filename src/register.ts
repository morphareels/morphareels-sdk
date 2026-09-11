// `registerAccount()` — get a Morpha API key with no browser and no human.
//
// This is the entry point for an agent that has been asked to make a video and
// holds no credential at all. It mints an anonymous account and returns an
// ordinary `mp_…` key, the same kind `/app/settings` hands a signed-in user,
// which `createClient({ token })` then takes unchanged, together with the
// account's claim link.
//
// Two things the account is NOT, both deliberate:
//
//   • It has no AI credit envelope. Drive the tool catalog with your own model
//     — it is free and unmetered. Calls to Morpha's own AI are refused.
//   • Nobody can sign into it. There is no password and no email, so the key is
//     the whole credential. The claim link is how it becomes permanent: when
//     the video is finished, give the person `claimUrl`. They sign in or sign
//     up, and the project moves into their own account. An anonymous account
//     nobody claims is deleted after 30 days.

/** Options for {@link registerAccount}. */
export interface RegisterAccountOptions {
  /** Origin to register against. Default `https://morphareels.ai`. */
  origin?: string;
  /** Label for the minted key. Default "Agent". */
  name?: string;
  /** Custom fetch (Node <18, or a test double). Default `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
}

export interface RegisteredAccount {
  /** The `mp_…` API key. Pass straight to `createClient({ token })`. */
  token: string;
  /**
   * The link that makes the account permanent. Give it to the person when the
   * work is done: they sign in or sign up, and the project moves into their own
   * Morpha account.
   */
  claimUrl: string;
}

export const registerAccount = async (
  options: RegisterAccountOptions = {},
): Promise<RegisteredAccount> => {
  const origin = (options.origin ?? "https://morphareels.ai").replace(/\/+$/, "");
  const doFetch = options.fetch ?? globalThis.fetch;
  if (typeof doFetch !== "function") {
    throw new Error(
      "No fetch available — pass options.fetch (Node <18) or run on Node >=18.",
    );
  }

  const res = await doFetch(`${origin}/api/auth/agent-register`, {
    method: "POST",
    headers: { "content-type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ name: options.name ?? "Agent" }),
  });

  if (!res.ok) {
    // 429 is the expected refusal and says so in `error`; surface it verbatim
    // rather than inventing a retry, since the caller knows its own schedule.
    const body = await res.text().catch(() => "");
    throw new Error(
      `registerAccount failed: ${res.status} ${res.statusText}${body ? ` — ${body}` : ""}`,
    );
  }

  const data = (await res.json()) as { token?: unknown; claimUrl?: unknown };
  if (typeof data.token !== "string" || !data.token.startsWith("mp_")) {
    throw new Error(
      "registerAccount: response carried no usable token. Check the origin is a Morpha deployment.",
    );
  }
  // Required, like the token: without it the work an agent does in this
  // account has no way to reach a person, so a response that lacks it is a
  // deployment too old to use rather than a detail to paper over.
  if (
    typeof data.claimUrl !== "string" ||
    !/^https?:\/\/[^/]+\/claim\/./.test(data.claimUrl)
  ) {
    throw new Error(
      "registerAccount: response carried no claim link. Check the origin is a current Morpha deployment.",
    );
  }
  return { token: data.token, claimUrl: data.claimUrl };
};
