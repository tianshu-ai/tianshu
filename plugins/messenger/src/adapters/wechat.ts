// WeChat send adapter.
//
// Delegates to the wechat plugin's channel hub to deliver text
// messages. Requires the wechat plugin to be active and the
// contact's config to reference a valid binding.

import type { SendAdapter } from "../tool.js";
import type { Contact } from "../schema.js";

export interface WeChatAdapterDeps {
  /** channelHub.send from the host — sends a message through a
   *  channel binding. */
  channelSend?: (
    bindingId: string,
    msg: { target: string; text: string },
  ) => Promise<void>;
}

export function createWeChatAdapter(deps: WeChatAdapterDeps): SendAdapter {
  return {
    async send(contact: Contact, text: string) {
      if (!deps.channelSend) {
        return { delivered: false, error: "WeChat plugin not active or channelHub unavailable" };
      }
      const bindingId = contact.config.bindingId as string | undefined;
      const wxId = contact.config.wxId as string | undefined;
      if (!bindingId || !wxId) {
        return { delivered: false, error: "Contact missing bindingId or wxId in config" };
      }
      try {
        await deps.channelSend(bindingId, { target: wxId, text });
        return { delivered: true };
      } catch (err) {
        return { delivered: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
