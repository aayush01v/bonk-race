/* ===================================================================
   Bonk Race — Homescreen Script
   Handles interactive eye tracking, character color picking,
   button hover sounds, and subtle UI animations.
   =================================================================== */

document.addEventListener('DOMContentLoaded', () => {
    const mainChar = document.getElementById('mainChar');
    const pupils = document.querySelectorAll('.pupil');

    // ──── Character eye tracking ────
    // Eyes follow the cursor for a lively feel
    document.addEventListener('mousemove', (e) => {
        const cx = window.innerWidth / 2;
        const cy = window.innerHeight * 0.6;
        const dx = (e.clientX - cx) / window.innerWidth;
        const dy = (e.clientY - cy) / window.innerHeight;
        const maxShift = 4;

        pupils.forEach(p => {
            p.style.transform = `translate(calc(-50% + ${dx * maxShift}px), ${dy * maxShift}px)`;
        });
    });

    // ──── Character colors from the game's KINDS ────
    const KINDS = [
        { name: 'Zombie',    c: '#8fd16a' },
        { name: 'Pumpkin',   c: '#ff9a3d' },
        { name: 'Ghost',     c: '#efe9ff' },
        { name: 'Robot',     c: '#8bd3ff' },
        { name: 'Bubblegum', c: '#ff8fb8' },
        { name: 'Banana',    c: '#ffd23f' }
    ];

    let currentKind = 0; // Start with Zombie (green, matching reference)

    function applyCharColor(kind) {
        const body = document.querySelector('.char-body');
        const feet = document.querySelectorAll('.foot');
        const avatarBlob = document.querySelector('.avatar-blob');

        // Darken the color slightly for feet/bottom
        const darken = (hex, amount) => {
            const num = parseInt(hex.slice(1), 16);
            const r = Math.max(0, ((num >> 16) & 255) - amount);
            const g = Math.max(0, ((num >> 8) & 255) - amount);
            const b = Math.max(0, (num & 255) - amount);
            return `rgb(${r},${g},${b})`;
        };

        const base = kind.c;
        const dark = darken(base, 30);

        body.style.background = `linear-gradient(180deg, ${base} 0%, ${dark} 100%)`;
        feet.forEach(f => {
            f.style.background = `linear-gradient(180deg, ${dark} 0%, ${darken(base, 55)} 100%)`;
        });
        avatarBlob.style.background = base;
    }

    applyCharColor(KINDS[currentKind]);

    // Click character to cycle colors
    const charContainer = document.querySelector('.character-container');
    charContainer.style.pointerEvents = 'auto';
    charContainer.style.cursor = 'pointer';
    charContainer.addEventListener('click', () => {
        currentKind = (currentKind + 1) % KINDS.length;
        applyCharColor(KINDS[currentKind]);

        // Bounce animation on click
        mainChar.style.animation = 'none';
        mainChar.offsetHeight; // force reflow
        mainChar.style.animation = '';

        // Quick squish effect
        const body = document.querySelector('.char-body');
        body.style.transition = 'transform 0.15s cubic-bezier(0.34,1.56,0.64,1)';
        body.style.transform = 'scaleX(1.15) scaleY(0.85)';
        setTimeout(() => {
            body.style.transform = 'scaleX(1) scaleY(1)';
        }, 150);
    });

    // ──── Button press feedback ────
    const allBtns = document.querySelectorAll('.side-btn, .play-btn, .season-banner, .profile-card, .currency, .settings-btn, .curr-add');

    allBtns.forEach(btn => {
        btn.addEventListener('mouseenter', () => {
            btn.style.transition = 'transform 0.12s, box-shadow 0.12s';
        });
    });

    // ──── Play button click ────
    const playBtn = document.getElementById('playBtn');
    playBtn.addEventListener('click', () => {
        // Flash the screen white briefly (like the game's veil transition)
        const veil = document.createElement('div');
        veil.style.cssText = `
            position: fixed; inset: 0; z-index: 999;
            background: #fffdf7; opacity: 0;
            transition: opacity 0.3s ease;
            pointer-events: none;
        `;
        document.body.appendChild(veil);
        requestAnimationFrame(() => {
            veil.style.opacity = '1';
            setTimeout(() => {
                veil.style.opacity = '0';
                setTimeout(() => veil.remove(), 350);
            }, 400);
        });
    });

    // ──── Parallax clouds on mouse move ────
    const clouds = document.querySelectorAll('.cloud');
    document.addEventListener('mousemove', (e) => {
        const x = (e.clientX / window.innerWidth - 0.5);
        clouds.forEach((c, i) => {
            const speed = (i + 1) * 8;
            c.style.marginLeft = `${x * speed}px`;
        });
    });
});
