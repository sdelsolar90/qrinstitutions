function getSessionId() {
    const hashParams = new URLSearchParams(window.location.hash.substring(1));
    const hashSession = hashParams.get('sessionId');
    if (hashSession) return hashSession;

    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get('sessionId');
}

const sessionId = getSessionId();
const pageQueryParams = new URLSearchParams(window.location.search);
let activeInstitutionId = pageQueryParams.get('institutionId') || '';

function normalizeEmail(value) {
    return String(value || '').trim().toLowerCase();
}

function isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function resolveAssetUrl(rawUrl) {
    const value = String(rawUrl || '').trim();
    if (!value) return '';
    if (/^(https?:)?\/\//i.test(value) || value.startsWith('data:') || value.startsWith('blob:')) {
        return value;
    }
    if (value.startsWith('/')) {
        return window.location.origin + value;
    }
    return window.location.origin + '/' + value;
}

async function generateDeviceFingerprint() {
    try {
        const today = new Date().toISOString().split('T')[0];
        const cacheKey = `fingerprint-${today}`;
        const cachedFingerprint = localStorage.getItem(cacheKey);
        if (cachedFingerprint) return cachedFingerprint;

        const fingerprintData = {
            userAgent: navigator.userAgent,
            screenResolution: `${window.screen.width}x${window.screen.height}`,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            language: navigator.language,
            hardwareConcurrency: navigator.hardwareConcurrency || 'unknown',
            deviceMemory: navigator.deviceMemory || 'unknown',
            touchSupport: 'ontouchstart' in window,
            dateSalt: today,
        };

        try {
            const canvas = document.createElement('canvas');
            canvas.width = 100;
            canvas.height = 30;
            const ctx = canvas.getContext('2d');
            ctx.textBaseline = 'top';
            ctx.font = "14px 'Arial'";
            ctx.fillStyle = '#f60';
            ctx.fillRect(125, 1, 62, 20);
            ctx.fillStyle = '#069';
            ctx.fillText('Fingerprint', 2, 15);
            fingerprintData.canvasHash = canvas.toDataURL();
        } catch (error) {
            console.log('Canvas fingerprint failed:', error);
        }

        const fingerprintString = JSON.stringify(fingerprintData);
        const response = await fetch('/api/consistent-hash', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ input: fingerprintString }),
        });

        if (!response.ok) throw new Error('Hash API failed');
        const { fingerprint } = await response.json();

        localStorage.setItem(cacheKey, fingerprint);
        return fingerprint;
    } catch (error) {
        console.error('Fingerprint generation error:', error);
        return btoa(
            JSON.stringify({
                userAgent: navigator.userAgent,
                screenResolution: `${window.screen.width}x${window.screen.height}`,
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                salt: `fallback-${new Date().toISOString().split('T')[0]}`,
            })
        );
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('attendanceForm');
    if (!form) return;

    const statusElement = document.getElementById('status');
    const submitButton = form.querySelector("button[type='submit']");
    const API_ENDPOINT = '/mark-attendance';
    let isSubmitting = false;

    function restoreSubmitState() {
        isSubmitting = false;
        submitButton.disabled = false;
        submitButton.innerHTML = 'Submit Attendance';
    }

    const institutionLogo = document.getElementById('institutionLogo');
    const institutionLogoFallback = document.getElementById('institutionLogoFallback');

    function setInstitutionBrand(brand = {}) {
        if (!institutionLogo || !institutionLogoFallback) return;

        const name = String(brand.name || '').trim();
        const logoUrl = resolveAssetUrl(brand.logoUrl || '');
        if (!logoUrl) {
            institutionLogo.src = '';
            institutionLogo.classList.add('hidden');
            institutionLogoFallback.classList.remove('hidden');
            return;
        }

        institutionLogo.onload = () => {
            institutionLogo.classList.remove('hidden');
            institutionLogoFallback.classList.add('hidden');
        };
        institutionLogo.onerror = () => {
            institutionLogo.classList.add('hidden');
            institutionLogoFallback.classList.remove('hidden');
        };
        institutionLogo.alt = name ? name + ' logo' : 'Institution Logo';
        institutionLogo.src = logoUrl;
    }

    function applySessionContext(validationData) {
        if (!validationData || !validationData.session) return;
        if (validationData.session.institutionId) {
            activeInstitutionId = String(validationData.session.institutionId);
        }
        setInstitutionBrand(validationData.session.institutionBrand || {});
    }

    async function validateSessionContext() {
        const validationResponse = await fetch('/api/validate-session', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ sessionId }),
        });

        const validationData = await validationResponse.json();
        if (validationResponse.ok && validationData && validationData.valid) {
            applySessionContext(validationData);
        }

        return validationData;
    }

    if (sessionId) {
        validateSessionContext().catch(() => {
            // Keep fallback icon if session metadata cannot be loaded yet.
        });
    }

    const signatureCanvas = document.getElementById('signaturePad');
    const clearSignatureButton = document.getElementById('clearSignature');
    const signatureCtx = signatureCanvas ? signatureCanvas.getContext('2d') : null;
    let isDrawingSignature = false;
    let signatureDirty = false;

    function canvasSize() {
        const ratio = Math.max(window.devicePixelRatio || 1, 1);
        const width = signatureCanvas.clientWidth || 320;
        const height = signatureCanvas.clientHeight || 160;
        return { ratio, width, height };
    }

    function setupSignaturePad() {
        if (!signatureCanvas || !signatureCtx) return;
        const previousData = signatureDirty ? signatureCanvas.toDataURL('image/png') : null;

        const { ratio, width, height } = canvasSize();
        signatureCanvas.width = Math.floor(width * ratio);
        signatureCanvas.height = Math.floor(height * ratio);

        signatureCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
        signatureCtx.fillStyle = '#ffffff';
        signatureCtx.fillRect(0, 0, width, height);
        signatureCtx.lineWidth = 2;
        signatureCtx.lineCap = 'round';
        signatureCtx.lineJoin = 'round';
        signatureCtx.strokeStyle = '#111827';

        if (previousData) {
            const image = new Image();
            image.onload = () => {
                signatureCtx.drawImage(image, 0, 0, width, height);
            };
            image.src = previousData;
        }
    }

    function getCanvasPoint(clientX, clientY) {
        const rect = signatureCanvas.getBoundingClientRect();
        return {
            x: clientX - rect.left,
            y: clientY - rect.top,
        };
    }

    function beginStroke(clientX, clientY) {
        if (!signatureCtx) return;
        const point = getCanvasPoint(clientX, clientY);
        signatureCtx.beginPath();
        signatureCtx.moveTo(point.x, point.y);
        signatureCtx.lineTo(point.x, point.y);
        signatureCtx.stroke();
        isDrawingSignature = true;
        signatureDirty = true;
    }

    function extendStroke(clientX, clientY) {
        if (!signatureCtx || !isDrawingSignature) return;
        const point = getCanvasPoint(clientX, clientY);
        signatureCtx.lineTo(point.x, point.y);
        signatureCtx.stroke();
    }

    function endStroke() {
        if (!signatureCtx || !isDrawingSignature) return;
        signatureCtx.closePath();
        isDrawingSignature = false;
    }

    function clearSignature() {
        if (!signatureCanvas || !signatureCtx) return;
        const { ratio, width, height } = canvasSize();
        signatureCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
        signatureCtx.fillStyle = '#ffffff';
        signatureCtx.fillRect(0, 0, width, height);
        signatureDirty = false;
    }

    if (signatureCanvas && signatureCtx) {
        setupSignaturePad();
        window.addEventListener('resize', setupSignaturePad);

        if (window.PointerEvent) {
            signatureCanvas.addEventListener('pointerdown', (event) => {
                if (event.pointerType === 'mouse' && event.button !== 0) return;
                beginStroke(event.clientX, event.clientY);
                if (typeof signatureCanvas.setPointerCapture === 'function') {
                    signatureCanvas.setPointerCapture(event.pointerId);
                }
                event.preventDefault();
            });

            signatureCanvas.addEventListener('pointermove', (event) => {
                extendStroke(event.clientX, event.clientY);
                event.preventDefault();
            });

            const stopPointer = (event) => {
                endStroke();
                if (
                    typeof signatureCanvas.hasPointerCapture === 'function' &&
                    typeof signatureCanvas.releasePointerCapture === 'function' &&
                    signatureCanvas.hasPointerCapture(event.pointerId)
                ) {
                    signatureCanvas.releasePointerCapture(event.pointerId);
                }
            };

            signatureCanvas.addEventListener('pointerup', stopPointer);
            signatureCanvas.addEventListener('pointercancel', stopPointer);
            signatureCanvas.addEventListener('pointerleave', stopPointer);
        } else {
            signatureCanvas.addEventListener('mousedown', (event) => {
                if (event.button !== 0) return;
                beginStroke(event.clientX, event.clientY);
                event.preventDefault();
            });

            signatureCanvas.addEventListener('mousemove', (event) => {
                extendStroke(event.clientX, event.clientY);
                event.preventDefault();
            });

            signatureCanvas.addEventListener('mouseup', endStroke);
            signatureCanvas.addEventListener('mouseleave', endStroke);

            signatureCanvas.addEventListener(
                'touchstart',
                (event) => {
                    const touch = event.touches[0];
                    if (!touch) return;
                    beginStroke(touch.clientX, touch.clientY);
                    event.preventDefault();
                },
                { passive: false }
            );

            signatureCanvas.addEventListener(
                'touchmove',
                (event) => {
                    const touch = event.touches[0];
                    if (!touch) return;
                    extendStroke(touch.clientX, touch.clientY);
                    event.preventDefault();
                },
                { passive: false }
            );

            signatureCanvas.addEventListener('touchend', endStroke);
            signatureCanvas.addEventListener('touchcancel', endStroke);
        }

        if (clearSignatureButton) {
            clearSignatureButton.addEventListener('click', clearSignature);
        }
    }

    form.addEventListener('submit', async function (event) {
        event.preventDefault();

        if (!sessionId) {
            statusElement.innerText = 'Please scan the QR code first';
            statusElement.className = 'text-center mt-4 text-sm text-red-600';
            restoreSubmitState();
            return;
        }

        if (isSubmitting) return;
        isSubmitting = true;

        try {
            const validationData = await validateSessionContext();
            if (!validationData || !validationData.valid) {
                statusElement.innerText = 'Invalid QR session. Please scan again.';
                statusElement.className = 'text-center mt-4 text-sm text-red-600';
                restoreSubmitState();
                return;
            }

            submitButton.disabled = true;
            submitButton.innerHTML = 'Processing...';

            const name = String(document.getElementById('name').value || '').trim();
            const email = normalizeEmail(document.getElementById('email').value);

            if (!name || !email) {
                statusElement.innerText = 'Please fill Full Name and Email';
                statusElement.className = 'text-center mt-4 text-sm text-red-600';
                restoreSubmitState();
                return;
            }

            if (!isValidEmail(email)) {
                statusElement.innerText = 'Please enter a valid email';
                statusElement.className = 'text-center mt-4 text-sm text-red-600';
                restoreSubmitState();
                return;
            }

            const requiresSignature = validationData?.session?.requiresSignature !== false;
            if (requiresSignature && (!signatureCanvas || !signatureCtx || !signatureDirty)) {
                statusElement.innerText = 'Please add your signature';
                statusElement.className = 'text-center mt-4 text-sm text-red-600';
                restoreSubmitState();
                return;
            }

            const signatureDataUrl = (signatureCanvas && signatureCtx && signatureDirty)
                ? signatureCanvas.toDataURL('image/png')
                : '';
            const fingerprint = await generateDeviceFingerprint();
            const requiresLocation = validationData?.session?.requiresLocation === true;

            let location = null;
            if (requiresLocation) {
                if (!navigator.geolocation) {
                    statusElement.innerText = 'This course requires geolocation, but your browser does not support it.';
                    statusElement.className = 'text-center mt-4 text-sm text-red-600';
                    restoreSubmitState();
                    return;
                }

                try {
                    location = await new Promise((resolve, reject) => {
                        navigator.geolocation.getCurrentPosition(
                            (position) => resolve({
                                lat: position.coords.latitude,
                                lng: position.coords.longitude,
                            }),
                            (error) => reject(error),
                            { timeout: 10000, enableHighAccuracy: true }
                        );
                    });
                } catch (error) {
                    statusElement.innerText = `Location error: ${error.message}`;
                    statusElement.className = 'text-center mt-4 text-sm text-red-600';
                    restoreSubmitState();
                    return;
                }
            } else if (navigator.geolocation) {
                try {
                    location = await new Promise((resolve) => {
                        navigator.geolocation.getCurrentPosition(
                            (position) => resolve({
                                lat: position.coords.latitude,
                                lng: position.coords.longitude,
                            }),
                            () => resolve(null),
                            { timeout: 5000, enableHighAccuracy: true }
                        );
                    });
                } catch (_) {
                    location = null;
                }
            }

            const payload = {
                name,
                email,
                deviceFingerprint: fingerprint,
                signatureDataUrl,
                sessionId,
            };
            if (location && Number.isFinite(location.lat) && Number.isFinite(location.lng)) {
                payload.location = location;
            }

            try {
                const response = await fetch(API_ENDPOINT, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(payload),
                });

                const data = await response.json();

                if (
                    response.status === 400 &&
                    data.message &&
                    data.message.toLowerCase().includes('already marked attendance')
                ) {
                    statusElement.innerText = data.message;
                    statusElement.className = 'text-center mt-4 text-sm text-yellow-600';
                    const institutionQuery = activeInstitutionId
                        ? `&institutionId=${encodeURIComponent(activeInstitutionId)}`
                        : '';
                    window.location.href = `/dashboard.html?rollNo=${encodeURIComponent(email)}${institutionQuery}`;
                    return;
                }

                if (!response.ok) {
                    throw new Error(data.message || 'Failed to mark attendance');
                }

                statusElement.innerText = data.message;
                statusElement.className = 'text-center mt-4 text-sm text-green-600';

                const institutionQuery = activeInstitutionId
                    ? `&institutionId=${encodeURIComponent(activeInstitutionId)}`
                    : '';
                window.location.href = `/dashboard.html?rollNo=${encodeURIComponent(email)}${institutionQuery}`;
            } catch (error) {
                console.error('API error:', error);
                statusElement.innerText = error.message;
                statusElement.className = 'text-center mt-4 text-sm text-red-600';
            } finally {
                restoreSubmitState();
            }
        } catch (error) {
            console.error('Unexpected error:', error);
            statusElement.innerText = 'An unexpected error occurred.';
            statusElement.className = 'text-center mt-4 text-sm text-red-600';
            restoreSubmitState();
        }
    });
});
