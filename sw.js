const CACHE='asia2026-v5';
const ASSETS=['./','./index.html','./manifest.webmanifest','./icon.svg','./app.js','./ai.js','./dom.js','./app-config.js','./trip-core.js','./trip-data.json'];
const NETWORK_TIMEOUT_MS=4000; // slow/blocked networks (e.g. mainland China) fall back to the offline copy quickly
self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)))});
self.addEventListener('activate',e=>{e.waitUntil(Promise.all([self.clients.claim(),caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))]))});
// Same-origin GETs (pages, app code, trip data): network-first with timeout, cache as offline fallback.
// Everything else (AI backend, other origins, POST) is not touched by the service worker.
function networkFirst(req,key){
  const cached=()=>caches.match(key,{ignoreSearch:true});
  const net=fetch(req).then(res=>{if(res&&res.ok){const copy=res.clone();caches.open(CACHE).then(c=>c.put(key,copy))}return res});
  const timeout=new Promise(resolve=>setTimeout(resolve,NETWORK_TIMEOUT_MS));
  return Promise.race([net.catch(()=>null),timeout]).then(res=>res||cached().then(c=>c||net)).catch(()=>cached());
}
self.addEventListener('fetch',e=>{
  const req=e.request;
  if(req.method!=='GET')return;
  const url=new URL(req.url);
  if(url.origin!==self.location.origin)return;
  const isPage=req.mode==='navigate'||req.destination==='document';
  e.respondWith(networkFirst(req,isPage?'./index.html':req));
});
