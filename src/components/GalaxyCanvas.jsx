import { useEffect, useRef } from "react";

export default function GalaxyCanvas({ className = "", density = 0.00012, primary = "118, 227, 214" }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext("2d");
    let width = 0;
    let height = 0;
    let raf = 0;
    const stars = [];

    function resize() {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      width = rect.width;
      height = rect.height;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      stars.length = 0;
      const count = Math.min(420, Math.floor(width * height * density));
      for (let i = 0; i < count; i += 1) {
        stars.push({
          x: Math.random() * width,
          y: Math.random() * height,
          r: Math.random() * 1.7 + 0.4,
          vx: (Math.random() - 0.5) * 0.16,
          vy: Math.random() * 0.18 + 0.03,
          twinkle: Math.random() * Math.PI * 2,
          speed: Math.random() * 0.025 + 0.008,
          hot: Math.random() > 0.72
        });
      }
    }

    function drawGalaxy(t) {
      ctx.clearRect(0, 0, width, height);
      const cx = width * 0.42;
      const cy = height * 0.44;
      for (let i = 0; i < 3; i += 1) {
        const radius = Math.max(width, height) * (0.26 + i * 0.13);
        const pulse = 0.04 + Math.sin(t * 0.00022 + i) * 0.012;
        const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
        gradient.addColorStop(0, `rgba(${primary}, ${0.1 - i * 0.02})`);
        gradient.addColorStop(0.45, `rgba(${primary}, ${0.035 - i * 0.01})`);
        gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(cx, cy, radius * (1 + pulse), 0, Math.PI * 2);
        ctx.fill();
      }

      for (const star of stars) {
        star.x += star.vx;
        star.y += star.vy;
        star.twinkle += star.speed;
        if (star.x < -6) star.x = width + 6;
        if (star.x > width + 6) star.x = -6;
        if (star.y > height + 6) star.y = -6;
        const alpha = 0.35 + Math.abs(Math.sin(star.twinkle)) * 0.65;
        ctx.fillStyle = star.hot
          ? `rgba(150, 220, 255, ${alpha})`
          : `rgba(${primary}, ${alpha * 0.9})`;
        ctx.beginPath();
        ctx.arc(star.x, star.y, star.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    function frame(t) {
      drawGalaxy(t);
      raf = requestAnimationFrame(frame);
    }

    resize();
    raf = requestAnimationFrame(frame);
    window.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, [density, primary]);

  return <canvas ref={canvasRef} className={`galaxy-canvas ${className}`} aria-hidden="true" />;
}
