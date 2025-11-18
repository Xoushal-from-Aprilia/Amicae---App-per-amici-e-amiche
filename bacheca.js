// bacheca.js

// Variabili per memorizzare le dipendenze e lo stato locale
let db, appId, showMessage;
let collection, doc, addDoc, onSnapshot, query, orderBy, getDocs, deleteDoc, serverTimestamp;
let localUserId, localPairingCode;

// Stato della Bacheca
let currentWhiteboardId = null;
let whiteboardStrokes = new Map(); // Cache locale dei tratti {docId: strokeData}
let currentDrawingStroke = null; // Tratto { points: [], color: '', ... }
let isDrawing = false;
let whiteboardStrokesUnsubscribe = null;
let whiteboardMetaUnsubscribe = null; // Per ascoltare le bacheche
let allWhiteboards = []; // Lista di tutte le bacheche
let currentBoardIndex = -1; // Indice della bacheca attuale
let canvasOffsetX = 0;
let canvasOffsetY = 0;

// Elementi DOM (verranno popolati in init)
let whiteboardCanvas, whiteboardCtx, whiteboardContainer, whiteboardTitle;

/**
 * Inizializza il modulo della bacheca.
 * Questa funzione viene importata e chiamata dallo script principale.
 * @param {object} deps - Oggetto contenente le dipendenze (db, appId, showMessage, funzioni Firestore)
 * @returns {object} - Oggetto con le funzioni startWhiteboardView e stopWhiteboardListeners
 */
export function initializeBacheca(deps) {
    // 1. Memorizza tutte le dipendenze
    db = deps.db;
    appId = deps.appId;
    showMessage = deps.showMessage;
    collection = deps.collection;
    doc = deps.doc;
    addDoc = deps.addDoc;
    onSnapshot = deps.onSnapshot;
    query = deps.query;
    orderBy = deps.orderBy;
    getDocs = deps.getDocs;
    deleteDoc = deps.deleteDoc;
    serverTimestamp = deps.serverTimestamp;

    // 2. Ottieni gli elementi DOM
    whiteboardCanvas = document.getElementById('whiteboard-canvas');
    if (!whiteboardCanvas) {
        console.error("Errore fatale: Impossibile trovare #whiteboard-canvas");
        return;
    }
    whiteboardCtx = whiteboardCanvas.getContext('2d');
    whiteboardContainer = document.getElementById('whiteboard-container');
    whiteboardTitle = document.getElementById('whiteboard-title');
    const whiteboardNewBtn = document.getElementById('whiteboard-new-btn');
    const whiteboardClearBtn = document.getElementById('whiteboard-clear-btn');
    
    // 3. Inizializza e imposta i listener
    initWhiteboardCanvas(); // Aggiunge i listener per il disegno
    whiteboardNewBtn.addEventListener('click', () => createNewWhiteboard());
    whiteboardClearBtn.addEventListener('click', () => clearCurrentWhiteboard());
    
    // 4. Restituisci le funzioni di controllo
    return {
        startWhiteboardView,
        stopWhiteboardListeners
    };
}

// --- Funzioni Logiche e Helper della Bacheca ---

/**
 * Inizializza le proprietà del canvas e aggiunge i listener per il disegno.
 */
function initWhiteboardCanvas() {
    whiteboardCanvas.width = 2000;
    whiteboardCanvas.height = 2000;
    whiteboardCtx.lineCap = 'round';
    whiteboardCtx.lineJoin = 'round';
    whiteboardCtx.lineWidth = 4; // Imposta uno spessore di default
    whiteboardCtx.strokeStyle = '#1f2937'; // Imposta un colore di default

    // Eventi Mouse
    whiteboardCanvas.addEventListener('mousedown', handleDrawStart);
    whiteboardCanvas.addEventListener('mousemove', handleDrawMove);
    whiteboardCanvas.addEventListener('mouseup', handleDrawEnd);
    whiteboardCanvas.addEventListener('mouseout', handleDrawEnd); // Termina se il mouse esce

    // Eventi Touch
    // **** FIX: Aggiunto { passive: false } per permettere e.preventDefault() ****
    whiteboardCanvas.addEventListener('touchstart', handleDrawStart, { passive: false });
    whiteboardCanvas.addEventListener('touchmove', handleDrawMove, { passive: false });
    whiteboardCanvas.addEventListener('touchend', handleDrawEnd);
    whiteboardCanvas.addEventListener('touchcancel', handleDrawEnd); // Aggiunto per sicurezza
}

/**
 * Ottiene le coordinate corrette (mouse o touch) relative al canvas,
 * tenendo conto dello scroll del container.
 * @param {Event} e - L'evento mouse o touch
 * @returns {object} - Oggetto { x, y } o null se l'evento non è valido
 */
function getCoords(e) {
    // Previene lo scroll della pagina mentre si disegna (funziona grazie a { passive: false })
    e.preventDefault(); 
    
    // **** FIX: Usa il BoundingRect del CONTAINER, non del canvas ****
    const containerRect = whiteboardContainer.getBoundingClientRect();
    let clientX, clientY;

    if (e.touches && e.touches.length > 0) {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
    } else if (e.clientX) {
        clientX = e.clientX;
        clientY = e.clientY;
    } else {
        return null; // Evento non valido
    }

    // Calcola la posizione X/Y relativa al contenitore
    let x = clientX - containerRect.left;
    let y = clientY - containerRect.top;
    
    // Aggiungi l'offset dello scroll del container per ottenere la coordinata reale sul canvas
    x += whiteboardContainer.scrollLeft;
    y += whiteboardContainer.scrollTop;

    // Applica l'offset (per pan futuro)
    return { x: x - canvasOffsetX, y: y - canvasOffsetY };
}

/**
 * Gestisce l'inizio di un tratto (mousedown o touchstart).
 * @param {Event} e - L'evento
 */
function handleDrawStart(e) {
    const coords = getCoords(e);
    if (!coords) return;

    isDrawing = true;
    currentDrawingStroke = { 
        points: [coords], 
        color: '#1f2937', // text-gray-800
        width: 4,
        userId: localUserId // Usa l'ID utente locale
    };
    
    // Inizia a disegnare un punto (per tap)
    whiteboardCtx.beginPath();
    whiteboardCtx.moveTo(coords.x, coords.y);
    whiteboardCtx.lineTo(coords.x, coords.y); // Per disegnare un punto
    whiteboardCtx.stroke();
}

/**
 * Gestisce il movimento durante il disegno (mousemove o touchmove).
 * @param {Event} e - L'evento
 */
function handleDrawMove(e) {
    if (!isDrawing) return;
    
    const coords = getCoords(e);
    if (!coords) return;

    currentDrawingStroke.points.push(coords);
    
    // Ridisegna l'intero canvas per mostrare il tratto in tempo reale
    // (Più semplice che disegnare solo l'ultimo segmento)
    redrawWhiteboard(); 
}

/**
 * Gestisce la fine di un tratto (mouseup, mouseout, touchend).
 * @param {Event} e - L'evento
 */
function handleDrawEnd(e) {
    if (!isDrawing) return;
    isDrawing = false;
    
    // Salviamo solo se il tratto ha più di un punto (più di un semplice tap)
    if (currentDrawingStroke && currentDrawingStroke.points.length > 1) {
        saveStroke(currentDrawingStroke);
    }
    currentDrawingStroke = null;
    
    // Ridisegniamo per assicurarci che l'ultimo stato (da DB) sia corretto
    redrawWhiteboard();
}

/**
 * Salva il tratto completato su Firestore.
 * @param {object} stroke - L'oggetto tratto da salvare
 */
async function saveStroke(stroke) {
    if (!currentWhiteboardId || !localPairingCode) return; // Usa stato locale
    try {
        const strokesRef = collection(db, 'artifacts', appId, 'public/data/pairings', localPairingCode, 'whiteboards', currentWhiteboardId, 'strokes');
        await addDoc(strokesRef, stroke);
    } catch (error) {
        console.error("Errore salvataggio tratto:", error);
        showMessage("Errore nel salvare il tuo disegno.");
    }
}

/**
 * Pulisce e ridisegna l'intero canvas con tutti i tratti.
 */
function redrawWhiteboard() {
    // Pulisce l'intero canvas
    whiteboardCtx.clearRect(0, 0, whiteboardCanvas.width, whiteboardCanvas.height);
    
    // Applica trasformazione per Pan (futuro)
    whiteboardCtx.save();
    whiteboardCtx.translate(canvasOffsetX, canvasOffsetY);

    // Disegna tutti i tratti salvati (da Firestore)
    whiteboardStrokes.forEach(drawStroke);

    // Disegna il tratto corrente (che stiamo disegnando ora)
    if (currentDrawingStroke) {
        drawStroke(currentDrawingStroke);
    }
    
    whiteboardCtx.restore();
}

/**
 * Disegna un singolo oggetto tratto sul canvas.
 * @param {object} stroke - L'oggetto tratto
 */
function drawStroke(stroke) {
    if (!stroke || !stroke.points || stroke.points.length < 1) return;

    whiteboardCtx.beginPath();
    whiteboardCtx.moveTo(stroke.points[0].x, stroke.points[0].y);

    // Disegna una linea fluida tra i punti
    for (let i = 1; i < stroke.points.length; i++) {
        whiteboardCtx.lineTo(stroke.points[i].x, stroke.points[i].y);
    }

    whiteboardCtx.strokeStyle = stroke.color || '#1f2937';
    whiteboardCtx.lineWidth = stroke.width || 4;
    whiteboardCtx.stroke();
}

/**
 * Avvia la vista bacheca, imposta lo stato e avvia i listener.
 * Chiamata dallo script principale.
 * @param {string} currentUserId - L'ID dell'utente corrente
 * @param {string} currentPairingCode - Il codice di pairing corrente
 */
function startWhiteboardView(currentUserId, currentPairingCode) {
    localUserId = currentUserId;
    localPairingCode = currentPairingCode;

    // Validazione (già fatta nello script principale, ma per sicurezza)
    if (!localUserId || !localPairingCode) {
         console.error("startWhiteboardView chiamata senza userId o pairingCode");
         return;
    }
    
    // Centra la vista iniziale
    whiteboardContainer.scrollTop = (whiteboardCanvas.height - whiteboardContainer.clientHeight) / 2;
    whiteboardContainer.scrollLeft = (whiteboardCanvas.width - whiteboardContainer.clientWidth) / 2;

    // Avvia l'ascolto delle bacheche disponibili
    listenForWhiteboards();
}

/**
 * Ferma tutti i listener di Firestore per la bacheca e pulisce lo stato.
 * Chiamata dallo script principale.
 */
function stopWhiteboardListeners() {
    if (whiteboardStrokesUnsubscribe) {
        whiteboardStrokesUnsubscribe();
        whiteboardStrokesUnsubscribe = null;
    }
    if (whiteboardMetaUnsubscribe) {
        whiteboardMetaUnsubscribe();
        whiteboardMetaUnsubscribe = null;
    }
    whiteboardStrokes.clear();
    allWhiteboards = [];
    currentBoardIndex = -1;
    currentWhiteboardId = null;
    localUserId = null; // Pulisce i dati di sessione
    localPairingCode = null;
    console.log("Listener bacheca stoppati.");
}

/**
 * Si mette in ascolto della collezione 'whiteboards' per rilevare aggiunte/modifiche.
 */
function listenForWhiteboards() {
    if (whiteboardMetaUnsubscribe) whiteboardMetaUnsubscribe();
    if (!localPairingCode) return;
    
    const boardsRef = collection(db, 'artifacts', appId, 'public/data/pairings', localPairingCode, 'whiteboards');
    const q = query(boardsRef, orderBy("createdAt", "asc"));

    whiteboardMetaUnsubscribe = onSnapshot(q, async (snapshot) => {
        allWhiteboards = snapshot.docs;
        console.log(`Trovate ${allWhiteboards.length} bacheche.`);

        if (allWhiteboards.length === 0) {
            console.log("Nessuna bacheca, ne creo una...");
            await createNewWhiteboard("Bacheca 1");
        } else if (currentWhiteboardId === null || !allWhiteboards.find(doc => doc.id === currentWhiteboardId)) {
            currentBoardIndex = allWhiteboards.length - 1;
            loadWhiteboardByIndex(currentBoardIndex);
        } else {
            // Se la bacheca corrente esiste ancora, ricarichiamo i dati (potrebbe essere stato pulito)
            redrawWhiteboard();
        }
    }, (error) => {
        console.error("Errore ascolto bacheche:", error);
    });
}

/**
 * Carica una bacheca specifica in base al suo indice nell'array 'allWhiteboards'.
 * @param {number} index - L'indice della bacheca da caricare
 */
function loadWhiteboardByIndex(index) {
    if (index < 0 || index >= allWhiteboards.length) return;

    currentBoardIndex = index;
    const boardDoc = allWhiteboards[index];
    currentWhiteboardId = boardDoc.id;
    
    whiteboardTitle.textContent = boardDoc.data().name || `Bacheca ${index + 1}`;

    // Pulisce la bacheca precedente
    whiteboardStrokes.clear();
    if (whiteboardStrokesUnsubscribe) whiteboardStrokesUnsubscribe();

    const strokesRef = collection(db, 'artifacts', appId, 'public/data/pairings', localPairingCode, 'whiteboards', currentWhiteboardId, 'strokes');
    
    whiteboardStrokesUnsubscribe = onSnapshot(strokesRef, (snapshot) => {
        snapshot.docChanges().forEach(change => {
            if (change.type === "added" || change.type === "modified") {
                whiteboardStrokes.set(change.doc.id, change.doc.data());
            }
            if (change.type === "removed") {
                whiteboardStrokes.delete(change.doc.id);
            }
        });
        redrawWhiteboard(); // Ridisegna con i nuovi dati
    }, (error) => {
        console.error("Errore ascolto tratti:", error);
    });
}

/**
 * Crea un nuovo documento bacheca in Firestore.
 * @param {string} name - Il nome (opzionale) per la nuova bacheca
 */
async function createNewWhiteboard(name) {
     if (!localPairingCode) return;
     const boardsRef = collection(db, 'artifacts', appId, 'public/data/pairings', localPairingCode, 'whiteboards');
     try {
        const newName = name || `Bacheca ${allWhiteboards.length + 1}`;
        await addDoc(boardsRef, {
            name: newName,
            createdAt: serverTimestamp()
        });
        // Il listener 'listenForWhiteboards' rileverà la nuova bacheca
     } catch (error) {
         console.error("Errore creazione bacheca:", error);
     }
}

/**
 * Avvisa l'utente prima di pulire la bacheca (ma non la pulisce ancora).
 */
async function clearCurrentWhiteboard() {
    if (!currentWhiteboardId || !localPairingCode) return;

    // VEDI NOTA: Questo non è un 'confirm' bloccante.
    showMessage("Funzione 'Pulisci' non ancora implementata con conferma. Creare un modale di conferma dedicato per abilitare la cancellazione.");
    
   console.warn("La pulizia reale non è implementata. Serve un modale di conferma.");

    /*
    // CODICE DA ABILITARE DOPO AVER CREATO UN MODALE DI CONFERMA
    
    // Mostra il tuo modale di conferma... se l'utente clicca OK:
    
    console.log("Pulizia bacheca in corso...");
    const strokesRef = collection(db, 'artifacts', appId, 'public/data/pairings', localPairingCode, 'whiteboards', currentWhiteboardId, 'strokes');
    const snapshot = await getDocs(strokesRef);
    
    const deletePromises = [];
    snapshot.forEach(doc => {
        deletePromises.push(deleteDoc(doc.ref));
    });
    
    try {
        await Promise.all(deletePromises);
        showMessage("Bacheca pulita.");
        // Il listener onSnapshot aggiornerà la vista (svuotando la mappa whiteboardStrokes)
    } catch (error) {
        console.error("Errore pulizia bacheca:", error);
    }
    */
}