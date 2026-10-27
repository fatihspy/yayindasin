import { config } from './config.js';
import { createStore } from './storage.js';
import { createApp } from './app.js';

const store = await createStore();
const app = createApp(store);
app.listen(config.port, () => {
  console.log(`[yayindasin] listening on :${config.port} | ai=${config.anthropicKey ? 'on' : 'OFF'} | storage=${store.kind} | trainer=${config.trainerKey ? 'on' : 'OFF'}`);
});
