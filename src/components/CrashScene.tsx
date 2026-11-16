import { useLayoutEffect, useRef } from 'react';
import { MOUNTAIN_BG_URI, PLANE_SPRITE_URI } from '../data/crashAssets';
import {
  EXPLOSION_PEAK_URI,
  EXPLOSION_SMOKE_URI,
} from '../data/explosionAssets';
import { GamePhase, SceneResultBanner } from '../types/crash';

interface CrashSceneProps {
  phase: GamePhase;
  countdownSeconds: number;
  flightStartTime: number;
  crashedMultiplier: number;
  flightCrashedSec: number;
  flightGrowthK: number;
  resultBanner: SceneResultBanner | null;
}

// Radial quarter-circle countdown dial centered at (910, 231) matching screenshots
const DIAL_CX = 910;
const DIAL_CY = 231;
const TICK_R_INNER = 163;
const TICK_R_OUTER = 199;
const BASE_TICK_ANGLES_DEG = [-190, -170, -150, -130, -110, -90];
const DOT_CX = 774.7;
const DOT_CY = 250.2;

const MOUNTAIN_BG_STYLE = { backgroundImage: `url("${MOUNTAIN_BG_URI}")` };

function getTrajectoryGeometry(phase: GamePhase, elapsedSec: number) {
  const startX = 40;
  const startY = 289.5;
  const maxSpanX = 700; // 40 -> 740
  const maxSpanY = 197.5; // 289.5 -> 92.0 (exact tip asymptote measured from screenshots)

  if (phase === 'waiting') {
    return {
      pathD: `M ${startX} ${startY} C ${startX} ${startY} ${startX} ${startY} ${startX} ${startY}`,
      tipX: startX,
      tipY: startY,
      angleDeg: -6.5,
    };
  }

  // Smooth exponential climb matched to screenshots (1.07x, 1.17x, 1.31x, 3.42x, 10.10x, 20.49x, 24.95x)
  const t = Math.max(0, elapsedSec);
  const px = Math.min(1, 1 - Math.exp(-0.215 * t));
  const py = Math.min(1, 1 - Math.exp(-0.24 * t));

  // Subtle cruise hover once high altitude is reached (~15s+)
  const cruiseBlend = Math.max(0, Math.min(1, (t - 15) / 4));
  const hoverX = cruiseBlend * Math.sin((t - 15) * 1.1) * 2.5;
  const hoverY = cruiseBlend * Math.sin((t - 15) * 1.6) * 2.5;

  const tipX = startX + maxSpanX * px + hoverX;
  const tipY = startY - maxSpanY * py + hoverY;

  const dx = tipX - startX;
  const dy = startY - tipY;
  const c1x = startX + 0.5 * dx;
  const c1y = startY;
  const c2x = startX + 0.78 * dx;
  const c2y = startY - 0.42 * dy;

  // Evaluate tangent smoothly at t >= 0.05s
  const tTan = Math.max(0.05, t);
  const pxTan = Math.min(1, 1 - Math.exp(-0.215 * tTan));
  const pyTan = Math.min(1, 1 - Math.exp(-0.24 * tTan));
  const tanTipX = startX + maxSpanX * pxTan + hoverX;
  const tanTipY = startY - maxSpanY * pyTan + hoverY;
  const tanC2x = startX + 0.78 * (tanTipX - startX);
  const tanC2y = startY - 0.42 * (startY - tanTipY);

  const tanDx = Math.max(0.001, tanTipX - tanC2x);
  const tanDy = tanTipY - tanC2y;
  const curveAngle = (Math.atan2(tanDy, tanDx) * 180) / Math.PI;

  // Aligns plane sprite pitch cleanly to -4.17deg at 3.42x and smooth nose-up liftoff from frame 0
  const angleDeg = curveAngle + 32.8;

  return {
    pathD: `M ${startX} ${startY} C ${c1x} ${c1y} ${c2x} ${c2y} ${tipX} ${tipY}`,
    tipX,
    tipY,
    angleDeg,
  };
}

function renderMultiplierChars(value: number) {
  const formatted = value.toFixed(2);
  return (
    <>
      {formatted.split('').map((ch, idx) =>
        ch === '.' ? (
          <span key={`dot-${idx}`}>.</span>
        ) : (
          <span key={`d-${idx}`} className="mult-digit">
            {ch}
          </span>
        )
      )}
      <span>x</span>
    </>
  );
}

function writeMultiplierDom(el: HTMLElement, value: number) {
  const str = `${value.toFixed(2)}x`;
  if (el.childNodes.length !== str.length) {
    const frag = document.createDocumentFragment();
    for (let i = 0; i < str.length; i++) {
      const span = document.createElement('span');
      const ch = str[i];
      if (ch !== '.' && ch !== 'x') {
        span.className = 'mult-digit';
      }
      span.textContent = ch;
      frag.appendChild(span);
    }
    el.replaceChildren(frag);
    return;
  }

  for (let i = 0; i < str.length; i++) {
    const node = el.childNodes[i] as HTMLElement;
    const ch = str[i];
    if (node.textContent !== ch) {
      node.textContent = ch;
    }
    const wantsDigitClass = ch !== '.' && ch !== 'x';
    const hasDigitClass = node.className === 'mult-digit';
    if (wantsDigitClass !== hasDigitClass) {
      node.className = wantsDigitClass ? 'mult-digit' : '';
    }
  }
}

export function CrashScene({
  phase,
  countdownSeconds,
  flightStartTime,
  crashedMultiplier,
  flightCrashedSec,
  flightGrowthK,
  resultBanner,
}: CrashSceneProps) {
  const pathRef = useRef<SVGPathElement | null>(null);
  const planeRef = useRef<HTMLImageElement | null>(null);
  const flightMultRef = useRef<HTMLElement | null>(null);

  // Native 60/120fps direct DOM/SVG updates during flight to prevent full-tree React re-renders
  useLayoutEffect(() => {
    if (phase !== 'flight') return;

    let rafId = 0;
    const renderFrame = (now: number) => {
      const sec = Math.max(0, (now - flightStartTime) / 1000);
      const mult = Math.exp(flightGrowthK * sec);
      const geom = getTrajectoryGeometry('flight', sec);

      if (pathRef.current) {
        pathRef.current.setAttribute('d', geom.pathD);
      }
      if (planeRef.current) {
        planeRef.current.style.left = `${(geom.tipX / 1000) * 100}%`;
        planeRef.current.style.top = `${(geom.tipY / 356) * 100}%`;
        planeRef.current.style.transform = `translate(-8%, -88%) rotate(${geom.angleDeg}deg)`;
      }
      if (flightMultRef.current) {
        writeMultiplierDom(flightMultRef.current, mult);
      }

      rafId = requestAnimationFrame(renderFrame);
    };

    renderFrame(performance.now());
    return () => cancelAnimationFrame(rafId);
  }, [phase, flightStartTime, flightGrowthK]);

  const staticGeom = getTrajectoryGeometry(
    phase,
    phase === 'crashed' ? flightCrashedSec : 0
  );
  const leftPct = (staticGeom.tipX / 1000) * 100;
  const topPct = (staticGeom.tipY / 356) * 100;

  // Countdown ticks locked 1-to-1 with countdownSeconds and countdown-dot bounce
  const tickCount = Math.max(
    1,
    Math.min(BASE_TICK_ANGLES_DEG.length, countdownSeconds)
  );
  const visibleTicks = BASE_TICK_ANGLES_DEG.slice(0, tickCount);
  const activeTickIndex = visibleTicks.length - 1;

  return (
    <div className="scene-wrap">
      <section
        className="crash-scene"
        data-phase={phase}
        data-chart-lines={phase === 'waiting' ? 'false' : 'true'}
        aria-label="جولة الطائرة"
      >
        <div className="mountains-clip" aria-hidden="true">
          <div className="mountains">
            <span style={MOUNTAIN_BG_STYLE} />
            <span className="is-mirrored" style={MOUNTAIN_BG_STYLE} />
            <span style={MOUNTAIN_BG_STYLE} />
            <span className="is-mirrored" style={MOUNTAIN_BG_STYLE} />
          </div>
        </div>

        <div className="chart-grid" />
        <div className="chart-axis chart-axis-y">
          <i />
          <i />
          <i />
          <i />
          <i />
          <i />
        </div>
        <div className="chart-axis chart-axis-x">
          <i />
          <i />
          <i />
          <i />
          <i />
          <i />
        </div>

        <svg
          className="chart-layer trajectory-layer"
          viewBox="0 0 1000 356"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <defs>
            <linearGradient
              id="trajectory-gradient"
              gradientUnits="userSpaceOnUse"
              x1="40"
              y1="289.5"
              x2="740"
              y2="53.5"
            >
              <stop offset="0" className="path-stop-start" />
              <stop offset="0.55" className="path-stop-mid" />
              <stop offset="1" className="path-stop-end" />
            </linearGradient>
          </defs>
          {phase !== 'waiting' && (
            <>
              <path
                ref={pathRef}
                className="trajectory-path"
                d={staticGeom.pathD}
                stroke="url(#trajectory-gradient)"
              />
              {phase === 'crashed' && (
                <circle
                  className="trajectory-dot"
                  cx={staticGeom.tipX}
                  cy={staticGeom.tipY}
                  r="7"
                />
              )}
            </>
          )}
        </svg>

        {phase === 'waiting' && (
          <div
            className="round-countdown"
            aria-label={`تبدأ الجولة خلال ${countdownSeconds} ثوانٍ`}
          >
            <svg
              className="chart-layer countdown-layer"
              viewBox="0 0 1000 356"
              aria-hidden="true"
            >
              {visibleTicks.map((deg, idx) => {
                const rad = (deg * Math.PI) / 180;
                const x1 = DIAL_CX + TICK_R_INNER * Math.cos(rad);
                const y1 = DIAL_CY + TICK_R_INNER * Math.sin(rad);
                const x2 = DIAL_CX + TICK_R_OUTER * Math.cos(rad);
                const y2 = DIAL_CY + TICK_R_OUTER * Math.sin(rad);
                const isCurrent = idx === activeTickIndex;
                return (
                  <line
                    key={deg}
                    x1={x1}
                    y1={y1}
                    x2={x2}
                    y2={y2}
                    className={`countdown-mark ${isCurrent ? 'is-current' : ''}`}
                  />
                );
              })}
              <circle
                key={countdownSeconds}
                className="countdown-dot"
                cx={DOT_CX}
                cy={DOT_CY}
                r="8.5"
              />
            </svg>
            <strong>{countdownSeconds}</strong>
          </div>
        )}

        {phase === 'flight' && (
          <img
            ref={planeRef}
            className="plane"
            alt="طائرة"
            src={PLANE_SPRITE_URI}
            style={{
              left: `${leftPct}%`,
              top: `${topPct}%`,
              transform: `translate(-8%, -88%) rotate(${staticGeom.angleDeg}deg)`,
            }}
          />
        )}

        {phase === 'crashed' && (
          <>
            <img
              className="explosion explosion-smoke"
              src={EXPLOSION_SMOKE_URI}
              alt=""
              aria-hidden="true"
              style={{ left: `${leftPct}%`, top: `${topPct}%` }}
            />
            <img
              className="explosion explosion-peak"
              src={EXPLOSION_PEAK_URI}
              alt=""
              aria-hidden="true"
              style={{ left: `${leftPct}%`, top: `${topPct}%` }}
            />
          </>
        )}

        {phase === 'flight' && (
          <strong
            key="mult-flight"
            ref={flightMultRef}
            className="multiplier"
          />
        )}

        {phase === 'crashed' && (
          <strong key="mult-crashed" className="multiplier">
            {renderMultiplierChars(crashedMultiplier)}
          </strong>
        )}

        {resultBanner && (
          <div
            key={resultBanner.id}
            className={`scene-result ${
              resultBanner.type === 'win' ? 'is-win' : 'is-loss'
            }`}
          >
            {resultBanner.text}
          </div>
        )}
      </section>
    </div>
  );
}
