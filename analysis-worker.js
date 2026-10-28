// Runs heightmapExport.analyze away from the page, so the map keeps moving while the box is measured.
// The callbacks read the panel, so they run on the page. The worker asks for each answer and waits for it.
importScripts('export.js');

const replies = new Map();
let calls = 0;

function ask(name, args) {
  return new Promise(resolve => {
    replies.set(++calls, resolve);
    postMessage({type: 'call', id: calls, name: name, args: args});
  });
}

onmessage = async e => {
  const m = e.data;
  if (m.type === 'reply') {
    replies.get(m.id)(m.value);
    replies.delete(m.id);
    return;
  }
  const options = Object.assign({}, m.options);
  m.callbacks.forEach(name => {
    options[name] = (...args) => ask(name, args);
  });
  try {
    const result = await heightmapExport.analyze(options);
    postMessage({type: 'done', result: result}, [result.flood.dry.buffer]);
  } catch (err) {
    postMessage({type: 'failed', message: err.message});
  }
};
