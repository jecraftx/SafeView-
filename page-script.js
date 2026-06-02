(function() {
  const SAMPLE_MS = 50;
  const canvas = document.createElement('canvas');
  canvas.width = 32; canvas.height = 18;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let lastSample = 0;

  function getVideo() {
    return Array.from(document.querySelectorAll('video'))
      .filter(v => v.readyState >= 2 && !v.paused && !v.ended && v.offsetWidth > 0)
      .sort((a,b) => (b.offsetWidth*b.offsetHeight) - (a.offsetWidth*a.offsetHeight))[0] || null;
  }

  function computeLuminance(pixels) {
    let total = 0, count = 0;
    for (let i = 0; i < pixels.length; i += 16) {
      total += 0.299*(pixels[i]/255) + 0.587*(pixels[i+1]/255) + 0.114*(pixels[i+2]/255);
      count++;
    }
    return count > 0 ? total/count : -1;
  }

  function loop(ts) {
    requestAnimationFrame(loop);
    if (ts - lastSample < SAMPLE_MS) return;
    lastSample = ts;
    const vid = getVideo();
    if (!vid) return;
    try {
      ctx.drawImage(vid, 0, 0, 32, 18);
      const data = ctx.getImageData(0, 0, 32, 18);
      const lum = computeLuminance(data.data);
      if (lum >= 0) {
        window.postMessage({ type: 'SAFEVIEW_LUMINANCE', luminance: lum }, '*');
      }
    } catch(e) {}
  }

  requestAnimationFrame(loop);
})();