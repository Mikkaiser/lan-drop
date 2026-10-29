// Second address for the relay Worker, on Cloudflare Pages (*.pages.dev).
// Some networks can't reach the Cloudflare addresses *.workers.dev resolves to;
// this just forwards to the lan-drop-turn Worker through a service binding,
// so keys and the spending limit stay in one place.
export default {
  fetch(request, env) {
    return env.TURN.fetch(request);
  },
};
