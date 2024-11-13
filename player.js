document.addEventListener('DOMContentLoaded', async function() {
    const MAX_VOICES = 4;
    const INITIAL_VOLUME = 1 / MAX_VOICES;
    const ATTACK_TIME_RATIO = 0.1;
    const DECAY_TIME_RATIO = 0.1;
    const SUSTAIN_LEVEL = 0.7;
    const RELEASE_TIME_RATIO = 0.2;
    const GENERAL_VOLUME_RAMP_TIME = 0.2;
    const FREQUENCY_RATIO = new Fraction(9, 8);
    const TAIL_LENGTH = 8;

    let frequencyMultiplier = new Fraction(1, 1);
    let loopCount = 0;
    let originalBaseFrequency = null;
    let scheduledTimeouts = [];
    let pastModules = [];
    let isInitialClick = true;
    let isUpdatingVisuals = false;
    let currentTempo = 60;
    let earliestStart = Infinity;
    let latestEnd = 0;
    let lowestFreq = Infinity;
    let highestFreq = 0;
    let measureBars = [];
    let playhead = null;
    let playheadContainer = null;
    let currentTime = 0;
    let playheadTime = 0;
    let isPlaying = false;
    let isPaused = false;
    let isFadingOut = false;
    let pausedAtTime = 0;
    let totalPausedTime = 0;
    let oscillators = [];
    let isTrackingEnabled = false;
    let audioContext = new (window.AudioContext || window.webkitAudioContext)();
    let generalVolumeGainNode = audioContext.createGain();
    let compressor = audioContext.createDynamicsCompressor();

    generalVolumeGainNode.connect(compressor);
    compressor.connect(audioContext.destination);

    const myModule = await Module.loadFromJSON('moduleSetup.json');
    initializeTempo();
    initializeFrequency();

    const evaluatedNotes = myModule.evaluateModule();
    const newNotes = Object.keys(evaluatedNotes).map(id => evaluatedNotes[id]).filter(note => note.startTime && note.duration && note.frequency);

    const viewport = tapspace.createView('.myspaceapp');
    viewport.zoomable({ freedom: { type: 'TSR' } });

    const space = tapspace.createSpace();
    viewport.addChild(space);

    function frequencyToY(freq) {
        return -Math.log2(freq) * 100;
    }

    const baseNoteFreq = myModule.baseNote.getVariable('frequency').valueOf();
    const baseNoteY = frequencyToY(baseNoteFreq);
    const centerPoint = space.at(0, baseNoteY);
    viewport.translateTo(centerPoint);

    newNotes.forEach(note => {
        const startTime = note.startTime.valueOf();
        const endTime = startTime + note.duration.valueOf();
        const freq = note.frequency.valueOf();
        earliestStart = Math.min(earliestStart, startTime);
        latestEnd = Math.max(latestEnd, endTime);
        lowestFreq = Math.min(lowestFreq, freq);
        highestFreq = Math.max(highestFreq, freq);
    });

    Object.values(evaluatedNotes).forEach(note => {
        if (note.startTime) {
            const startTime = note.startTime.valueOf();
            const duration = note.duration ? note.duration.valueOf() : 0;
            const endTime = startTime + duration;

            earliestStart = Math.min(earliestStart, startTime);
            latestEnd = Math.max(latestEnd, endTime);

            if (note.frequency) {
                const freq = note.frequency.valueOf();
                lowestFreq = Math.min(lowestFreq, freq);
                highestFreq = Math.max(highestFreq, freq);
            }
        }
    });

    function updateFrequencyForNewLoop() {
        if (!originalBaseFrequency) {
            originalBaseFrequency = myModule.baseNote.getVariable('frequency').valueOf();
        }

        frequencyMultiplier = frequencyMultiplier.mul(FREQUENCY_RATIO);

        myModule.baseNote.setVariable('frequency', () => new Fraction(originalBaseFrequency).mul(frequencyMultiplier));

        const evaluatedNotes = myModule.evaluateModule();
        updateVisualNotes(evaluatedNotes);
        loopCount++;
    }

    function cleanupAudio() {
        scheduledTimeouts.forEach(timeout => clearTimeout(timeout));
        scheduledTimeouts = [];

        oscillators.forEach(oscObj => {
            try {
                oscObj.gainNode.gain.cancelScheduledValues(audioContext.currentTime);
                oscObj.oscillator.stop();
                oscObj.oscillator.disconnect();
                oscObj.gainNode.disconnect();
            } catch (e) {
            }
        });
        oscillators = [];

        if (audioContext.state !== 'running') {
            audioContext.close().then(() => {
                audioContext = new (window.AudioContext || window.webkitAudioContext)();
                generalVolumeGainNode = audioContext.createGain();
                compressor = audioContext.createDynamicsCompressor();
                generalVolumeGainNode.connect(compressor);
                compressor.connect(audioContext.destination);
                setVolume(document.getElementById('volumeSlider').value);
            });
        }
    }

    const glowStyle = `
        border: none;
        border-radius: 7px;
        box-shadow: 
            0 0 5px #ffa800,
            0 0 10px #ffa800,
            0 0 15px #ffa800;
        border: 1px solid white !important;
    `;

    function updateVisualNotes(evaluatedNotes) {
        if (isUpdatingVisuals) return;
        isUpdatingVisuals = true;

        const currentNotes = space.getChildren();
        if (currentNotes.length > 0) {
            currentNotes.forEach(note => {
                if (note.element) {
                    note.element.style.boxShadow = 'none';
                    note.element.style.border = 'none';
                }
            });

            pastModules.push({ notes: currentNotes, opacity: 1 });
        }

        for (let i = pastModules.length - 1; i >= 0; i--) {
            const linearProgress = (pastModules.length - i) / TAIL_LENGTH;
            const cubicProgress = 1 - Math.pow(1 - linearProgress, 3);
            const newOpacity = 1 - cubicProgress;

            pastModules[i].opacity = newOpacity;

            if (newOpacity <= 0 || pastModules.length > TAIL_LENGTH) {
                pastModules[i].notes.forEach(note => {
                    note.remove();
                    space.removeChild(note);
                });
                pastModules.splice(i, 1);
            } else {
                pastModules[i].notes.forEach(note => {
                    if (note.element) {
                        note.element.style.opacity = newOpacity;
                    }
                });
            }
        }

        const newNotes = Object.keys(evaluatedNotes)
            .map(id => evaluatedNotes[id])
            .filter(note => note.startTime && note.duration && note.frequency)
            .sort((a, b) => a.startTime.valueOf() - b.startTime.valueOf());

        newNotes.forEach((note, index) => {
            const startTime = note.startTime.valueOf();
            const duration = note.duration.valueOf();
            const frequency = note.frequency.valueOf();

            const noteRect = createNoteElement(note, index);

            noteRect.element.style.cssText += glowStyle;

            const x = (startTime - earliestStart) * 200;
            const y = frequencyToY(frequency);
            const width = duration * 200;
            const height = 20;

            noteRect.setSize({ width: width, height: height });
            space.addChild(noteRect, { x: x, y: y });
        });

        isUpdatingVisuals = false;
    }

    function getFrequencyMultiplier(note) {
        const freqStr = note.frequencyString;

        if (freqStr) {
            const fractionMatch = freqStr.match(/new Fraction\((\d+),\s*(\d+)\)/);
            if (fractionMatch) {
                const noteFraction = new Fraction(parseInt(fractionMatch[1]), parseInt(fractionMatch[2]));
                const actualFraction = noteFraction.mul(frequencyMultiplier);
                return `${actualFraction.n}/${actualFraction.d}`;
            }
        }

        return '1/1';
    }

    function createNoteElement(note, index) {
        const multiplier = getFrequencyMultiplier(note);
        const [numerator, denominator] = multiplier.split('/');

        const measureDiv = document.createElement('div');
        measureDiv.style.position = 'absolute';
        measureDiv.style.visibility = 'hidden';
        measureDiv.style.fontSize = '8px';
        measureDiv.style.whiteSpace = 'nowrap';
        document.body.appendChild(measureDiv);

        measureDiv.textContent = numerator;
        const numWidth = measureDiv.offsetWidth;
        measureDiv.textContent = denominator;
        const denWidth = measureDiv.offsetWidth;
        document.body.removeChild(measureDiv);

        const maxWidth = Math.max(numWidth, denWidth);

        const noteRect = tapspace.createItem(`
            <div class="note-rect" style="
                overflow: hidden;
                width: 100%;
                height: 100%;
                background-color: ${getColorForNote(note)};
                border-radius: 6px;
                position: relative;
                pointer-events: none;
                display: flex;
                align-items: center;
                box-sizing: border-box;
            ">
                <div style="
                    display: flex;
                    align-items: center;
                    font-size: 7px;
                    color: white;
                    text-shadow: 0 0 1px black;
                    pointer-events: none;
                    padding-left: 4px;
                    height: 100%;
                ">
                    <div style="
                        position: relative;
                        display: flex;
                        flex-direction: column;
                        justify-content: center;
                        height: 100%;
                    ">
                        <div style="
                            position: relative;
                            display: flex;
                            flex-direction: column;
                            align-items: flex-start;
                            gap: 0px;
                        ">
                            <span>${numerator}</span>
                            <div style="
                                width: ${maxWidth}px;
                                height: 1px;
                                background: white;
                                margin: 0;
                            "></div>
                            <span>${denominator}</span>
                        </div>
                    </div>
                </div>
            </div>
        `);

        return noteRect;
    }

    function createMeasureBars() {
        measureBars.forEach(bar => bar.remove());
        measureBars = [];
        if (playhead) playhead.remove();

        const barsContainer = document.getElementById('measureBarsContainer');
        playheadContainer = document.getElementById('playheadContainer');

        barsContainer.innerHTML = '';
        playheadContainer.innerHTML = '';

        playhead = document.createElement('div');
        playhead.className = 'playhead';
        playheadContainer.appendChild(playhead);

        const freshEvaluatedNotes = myModule.evaluateModule();

        const measurePoints = Object.values(freshEvaluatedNotes)
            .filter(note => note.startTime && !note.duration && !note.frequency)
            .sort((a, b) => a.startTime.valueOf() - b.startTime.valueOf());

        measurePoints.forEach((measurePoint) => {
            const bar = document.createElement('div');
            bar.className = 'measure-bar';
            barsContainer.appendChild(bar);
            measureBars.push(bar);
        });

        const finalBar = document.createElement('div');
        finalBar.className = 'measure-bar';
        barsContainer.appendChild(finalBar);
        measureBars.push(finalBar);

        updateMeasureBarPositions(freshEvaluatedNotes);
    }

    function updateMeasureBarPositions(currentEvaluatedNotes = null) {
		if (!currentEvaluatedNotes) {
			currentEvaluatedNotes = myModule.evaluateModule();
		}

		const transform = viewport.getBasis().getRaw();
		const scale = Math.sqrt(transform.a * transform.a + transform.b * transform.b);

		const measurePoints = Object.values(currentEvaluatedNotes)
			.filter(note => note.startTime && !note.duration && !note.frequency)
			.sort((a, b) => a.startTime.valueOf() - b.startTime.valueOf());

		measureBars.forEach((bar, index) => {
			let x, screenPos;

			if (index === measureBars.length - 1) {
				x = latestEnd * 200;
				const point = new tapspace.geometry.Point(space, { x: x, y: 0 });
				screenPos = point.transitRaw(viewport);
			} else {
				if (measurePoints[index]) {
					const startTime = measurePoints[index].startTime.valueOf();
					x = startTime * 200;
					const point = new tapspace.geometry.Point(space, { x: x, y: 0 });
					screenPos = point.transitRaw(viewport);
				} else {
					return;
				}
			}

			const transform = `translate(${screenPos.x}px, 0) scale(${1 / scale}, 1)`;
			bar.style.transform = transform;
		});

		requestAnimationFrame(() => updateMeasureBarPositions());
	}

    function updatePlayhead() {
        if (isPlaying && !isPaused && !isFadingOut) {
            playheadTime = audioContext.currentTime - currentTime + totalPausedTime;

            if (playheadTime >= latestEnd) {
                playheadTime = 0;
                totalPausedTime = 0;
                currentTime = audioContext.currentTime;
                pausedAtTime = 0;
            }
        }

        const x = playheadTime * 200;

        if (isTrackingEnabled && isPlaying && !isPaused) {
            const viewCenter = viewport.atCenter();
            const targetPoint = space.at(x, viewCenter.transitRaw(space).y);

            viewport.match({
                source: viewCenter,
                target: targetPoint,
                estimator: 'X'
            });
        }

        const transform = viewport.getBasis().getRaw();
        const scale = Math.sqrt(transform.a * transform.a + transform.b * transform.b);
        const point = new tapspace.geometry.Point(space, { x: x, y: 0 });
        const screenPos = point.transitRaw(viewport);
        playhead.style.transform = `translate(${screenPos.x}px, 0) scale(${1 / scale}, 1)`;

        requestAnimationFrame(updatePlayhead);
    }

    createMeasureBars();
    requestAnimationFrame(updatePlayhead);
    requestAnimationFrame(updateMeasureBarPositions);

    function getColorForNote(note) {
        if (note.color) {
            return note.color;
        }

        const hue = Math.random() * 360;
        const newColor = `hsl(${hue}, 70%, 60%)`;

        note.color = () => newColor;

        return newColor;
    }

    newNotes.forEach((note, index) => {
        const startTime = note.startTime.valueOf();
        const duration = note.duration.valueOf();
        const frequency = note.frequency.valueOf();

        const noteRect = createNoteElement(note, index);
        noteRect.element.style.cssText += glowStyle;

        const x = (startTime - earliestStart) * 200;
        const y = frequencyToY(frequency);
        const width = duration * 200;
        const height = 20;

        noteRect.setSize({ width: width, height: height });
        space.addChild(noteRect, { x: x, y: y });
    });

    function playNote(note, startTime) {
        try {
            const oscillator = audioContext.createOscillator();
            const gainNode = audioContext.createGain();

            oscillator.frequency.value = note.frequency.valueOf();
            oscillator.type = 'sine';
            gainNode.gain.value = 0;

            const duration = note.duration.valueOf();
            const attackTime = duration * ATTACK_TIME_RATIO;
            const decayTime = duration * DECAY_TIME_RATIO;
            const releaseTime = duration * RELEASE_TIME_RATIO;
            const sustainTime = duration - attackTime - decayTime - releaseTime;

            gainNode.gain.setValueAtTime(0, startTime);
            gainNode.gain.linearRampToValueAtTime(INITIAL_VOLUME, startTime + attackTime);
            gainNode.gain.linearRampToValueAtTime(INITIAL_VOLUME * SUSTAIN_LEVEL, startTime + attackTime + decayTime);
            gainNode.gain.setValueAtTime(INITIAL_VOLUME * SUSTAIN_LEVEL, startTime + attackTime + decayTime + sustainTime);
            gainNode.gain.linearRampToValueAtTime(0, startTime + duration);

            oscillator.connect(gainNode);
            gainNode.connect(generalVolumeGainNode);

            oscillator.start(startTime);
            oscillator.stop(startTime + duration);

            oscillators.push({ oscillator, gainNode });

            oscillator.onended = () => {
                const index = oscillators.findIndex(oscObj => oscObj.oscillator === oscillator);
                if (index !== -1) {
                    oscillators.splice(index, 1);
                }
            };
        } catch (e) {
            console.error('Error in playNote:', e);
        }
    }

    function play(fromTime = 0) {
        if (isPlaying) return;

        if (isInitialClick) {
            audioContext.resume().then(() => {
                isInitialClick = false;
                startPlayback(fromTime);
            });
            return;
        }

        cleanupAudio();

        if (isPaused) {
            startPlayback(playheadTime);
        } else {
            startPlayback(fromTime);
        }
    }

    function startPlayback(fromTime) {
        currentTime = audioContext.currentTime;
        isPlaying = true;
        isPaused = false;

        const evaluatedNotes = myModule.evaluateModule();

        const activeNotes = Object.keys(evaluatedNotes)
            .map(id => evaluatedNotes[id])
            .filter(note => {
                if (!note.startTime || !note.duration || !note.frequency) return false;
                const noteStart = note.startTime.valueOf();
                const noteEnd = noteStart + note.duration.valueOf();
                return noteEnd > fromTime;
            });

        activeNotes.forEach(note => {
            const noteStart = note.startTime.valueOf();
            const noteEnd = noteStart + note.duration.valueOf();
            const adjustedStart = Math.max(0, noteStart - fromTime);
            const adjustedDuration = noteEnd - Math.max(noteStart, fromTime);

            try {
                playNote({
                    ...note,
                    startTime: new Fraction(adjustedStart),
                    duration: new Fraction(adjustedDuration)
                }, currentTime + adjustedStart);
            } catch (e) {
                console.error('Failed to play note:', e);
            }
        });

        const remainingTime = latestEnd - fromTime;
        const scheduleAheadTime = 0.1;

        const timeout = setTimeout(() => {
            if (isPlaying) {
                updateFrequencyForNewLoop();
                currentTime = audioContext.currentTime;
                playheadTime = 0;
                totalPausedTime = 0;
                pausedAtTime = 0;
                playNotes(myModule.evaluateModule(), 0);
            }
        }, (remainingTime - scheduleAheadTime) * 1000);

        scheduledTimeouts.push(timeout);
    }

    function playNotes(evaluatedNotes, startOffset) {
        if (!isPlaying) return;

        const notes = Object.keys(evaluatedNotes)
            .map(id => evaluatedNotes[id])
            .filter(note => note.startTime && note.duration && note.frequency);

        notes.forEach(note => {
            if (!isPlaying) return;

            const noteStartTime = note.startTime.valueOf();
            const noteEndTime = noteStartTime + note.duration.valueOf();

            try {
                playNote({
                    ...note,
                    startTime: new Fraction(noteStartTime),
                    duration: new Fraction(noteEndTime - noteStartTime)
                }, currentTime + startOffset + noteStartTime);
            } catch (e) {
                console.error('Failed to play note:', e);
            }
        });

        scheduleNextLoop();
    }

    function scheduleNextLoop() {
        if (!isPlaying) return;

        const loopDuration = latestEnd;
        const scheduleAheadTime = 0.1;

        const timeout = setTimeout(() => {
            if (isPlaying) {
                updateFrequencyForNewLoop();
                currentTime = audioContext.currentTime;
                playheadTime = 0;

                const evaluatedNotes = myModule.evaluateModule();
                playNotes(evaluatedNotes, 0);
            }
        }, (loopDuration - scheduleAheadTime) * 1000);

        scheduledTimeouts.push(timeout);
    }

    function pause() {
        if (!isPlaying || isPaused) return;

        isPaused = true;
        isFadingOut = true;

        const currentPauseTime = audioContext.currentTime - currentTime;
        playheadTime = currentPauseTime + totalPausedTime;
        pausedAtTime = currentPauseTime;
        totalPausedTime += currentPauseTime;

        cleanupAudio();

        setTimeout(() => {
            isPlaying = false;
            isFadingOut = false;
        }, GENERAL_VOLUME_RAMP_TIME * 1000);
    }

    function stop() {
        if (!isPlaying && !isPaused) return;

        frequencyMultiplier = new Fraction(1, 1);
        if (originalBaseFrequency) {
            myModule.baseNote.setVariable('frequency', () => new Fraction(originalBaseFrequency));
        }
        loopCount = 0;

        pastModules.forEach(module => {
            module.notes.forEach(note => {
                note.remove();
                space.removeChild(note);
            });
        });
        pastModules = [];

        const currentNotes = space.getChildren();
        currentNotes.forEach(note => {
            note.remove();
            space.removeChild(note);
        });

        const evaluatedNotes = myModule.evaluateModule();
        updateVisualNotes(evaluatedNotes);

        playheadTime = 0;
        totalPausedTime = 0;
        pausedAtTime = 0;
        isPlaying = false;
        isPaused = false;
        isFadingOut = false;

        if (isTrackingEnabled) {
            const viewCenter = viewport.atCenter();
            const targetPoint = new tapspace.geometry.Point(space, {
                x: 0,
                y: viewCenter.transitRaw(space).y,
                z: 0
            });
            viewport.translateTo(targetPoint);
        }

        cleanupAudio();
    }

    function setVolume(value) {
        if (isPlaying) {
            generalVolumeGainNode.gain.linearRampToValueAtTime(value, audioContext.currentTime + GENERAL_VOLUME_RAMP_TIME);
        } else {
            generalVolumeGainNode.gain.value = value;
        }
    }

    const dropdownButton = document.querySelector('.dropdown-button');
    const plusminus = document.querySelector('.plusminus');
    const widget = document.getElementById('general-widget');

    dropdownButton.addEventListener('click', (event) => {
        event.stopPropagation();
        plusminus.classList.toggle('open');
        widget.classList.toggle('open');
    });

    document.getElementById('volumeSlider').addEventListener('touchstart', function() {
        this.classList.add('active');
    });

    document.getElementById('volumeSlider').addEventListener('touchend', function() {
        this.classList.remove('active');
    });

    document.addEventListener('click', (event) => {
        if (!widget.contains(event.target) && !dropdownButton.contains(event.target)) {
            plusminus.classList.remove('open');
            widget.classList.remove('open');
        }
    });

    const sliders = document.querySelectorAll('.slider-container input[type="range"]');
    sliders.forEach(slider => {
        const valueDisplay = slider.parentElement.querySelector('span');
        slider.addEventListener('input', (e) => {
            valueDisplay.textContent = e.target.value;
        });
    });

    document.getElementById('trackingToggle').addEventListener('change', (event) => {
        isTrackingEnabled = event.target.checked;

        if (isTrackingEnabled) {
            const x = playheadTime * 200;
            const viewCenter = viewport.atCenter();
            const targetPoint = new tapspace.geometry.Point(space, {
                x: x,
                y: viewCenter.transitRaw(space).y,
                z: 0
            });
            viewport.translateTo(targetPoint);
        }
    });

    document.getElementById('playPauseBtn').addEventListener('click', () => {
        const pp = document.querySelector('.pp');
        if (isPlaying) {
            pp.classList.remove('open');
            pause();
        } else {
            pp.classList.add('open');
            if (isPaused) {
                play(totalPausedTime);
            } else {
                play();
            }
        }
    });

    document.getElementById('stopButton').addEventListener('click', () => {
        const pp = document.querySelector('.pp');
        pp.classList.remove('open');
        stop();
    });

    document.getElementById('volumeSlider').addEventListener('input', (event) => {
        setVolume(event.target.value);
    });

    function initializeTempo() {
        const tempoValue = myModule.baseNote.getVariable('tempo').valueOf();
        currentTempo = tempoValue;
        const tempoInput = document.getElementById('tempo-input');
        if (tempoInput) {
            tempoInput.value = tempoValue;
        } else {
            console.error('Tempo input element not found!');
        }
    }

    function handleTempoSubmit() {
        const tempoInput = document.getElementById('tempo-input');
        const newTempo = parseInt(tempoInput.value);

        if (isNaN(newTempo) || newTempo < 3 || newTempo > 999) {
            tempoInput.value = currentTempo;
            return;
        }

        updateTempo(newTempo);
    }

    function updateTempo(newTempo) {
        myModule.baseNote.setVariable('tempo', () => new Fraction(newTempo));
        currentTempo = newTempo;

        if (isPlaying || isPaused) {
            const pp = document.querySelector('.pp');
            pp.classList.remove('open');
            stop();
        }

        const freshEvaluatedNotes = myModule.evaluateModule();

        earliestStart = Infinity;
        latestEnd = 0;

        Object.values(freshEvaluatedNotes).forEach(note => {
            if (note.startTime) {
                const startTime = note.startTime.valueOf();
                const duration = note.duration ? note.duration.valueOf() : 0;
                const endTime = startTime + duration;

                earliestStart = Math.min(earliestStart, startTime);
                latestEnd = Math.max(latestEnd, endTime);
            }
        });

        const currentNotes = space.getChildren();
        currentNotes.forEach(note => {
            note.remove();
            space.removeChild(note);
        });

        pastModules.forEach(module => {
            module.notes.forEach(note => {
                note.remove();
                space.removeChild(note);
            });
        });
        pastModules = [];

        updateVisualNotes(freshEvaluatedNotes);
        createMeasureBars();
    }

    function initializeFrequency() {
        const frequencyValue = myModule.baseNote.getVariable('frequency').valueOf();
        const frequencyInput = document.getElementById('frequency-input');
        if (frequencyInput) {
            frequencyInput.value = frequencyValue;
        } else {
            console.error('Frequency input element not found!');
        }
    }

    function handleFrequencySubmit() {
        const frequencyInput = document.getElementById('frequency-input');
        const newFrequency = parseInt(frequencyInput.value);

        if (isNaN(newFrequency) || newFrequency < 20 || newFrequency > 2000) {
            frequencyInput.value = myModule.baseNote.getVariable('frequency').valueOf();
            return;
        }

        updateFrequency(newFrequency);
    }

    function updateFrequency(newFrequency) {
        originalBaseFrequency = newFrequency;

        myModule.baseNote.setVariable('frequency', () => new Fraction(newFrequency));

        if (isPlaying || isPaused) {
            const pp = document.querySelector('.pp');
            pp.classList.remove('open');
            stop();
        }

        frequencyMultiplier = new Fraction(1, 1);
        loopCount = 0;

        const freshEvaluatedNotes = myModule.evaluateModule();

        const currentNotes = space.getChildren();
        currentNotes.forEach(note => {
            note.remove();
            space.removeChild(note);
        });

        pastModules.forEach(module => {
            module.notes.forEach(note => {
                note.remove();
                space.removeChild(note);
            });
        });
        pastModules = [];

        updateVisualNotes(freshEvaluatedNotes);
    }

    document.getElementById('frequency-submit').addEventListener('click', handleFrequencySubmit);
    document.getElementById('frequency-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            handleFrequencySubmit();
        }
    });

    document.getElementById('tempo-submit').addEventListener('click', handleTempoSubmit);
    document.getElementById('tempo-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            handleTempoSubmit();
        }
    });

    setVolume(document.getElementById('volumeSlider').value);
});