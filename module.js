class Module {
    constructor(baseNoteVariables = {}) {
        this.notes = {};
        this.nextId = 1;

        const defaultBaseNoteVariables = {
            frequency: () => new Fraction(440),
            startTime: () => new Fraction(0),
            tempo: () => new Fraction(60),
            beatsPerMeasure: () => new Fraction(4),
            measureLength: () => {
                const tempo = this.getNoteById(0).getVariable('tempo');
                const beatsPerMeasure = this.getNoteById(0).getVariable('beatsPerMeasure');
                return beatsPerMeasure.div(tempo).mul(60);
            },
        };

        const finalBaseNoteVariables = { ...defaultBaseNoteVariables, ...baseNoteVariables };

        this.baseNote = new Note(0, finalBaseNoteVariables);
        this.notes[0] = this.baseNote;
    }

    addNote(variables = {}) {
        const id = this.nextId++;
        const note = new Note(id, variables);
        this.notes[id] = note;
        return note;
    }

    removeNote(id) {
        delete this.notes[id];
    }

    getNoteById(id) {
        return this.notes[id];
    }

    evaluateModule() {
        const evaluatedNotes = {};
        for (const id of Object.keys(this.notes)) {
            evaluatedNotes[id] = this.notes[id].getAllVariables();
        }
        return evaluatedNotes;
    }

    findMeasureLength(note) {
        const tempo = this.findTempo(note);
        const beatsPerMeasure = this.baseNote.getVariable('beatsPerMeasure');
        return beatsPerMeasure.div(tempo).mul(60);
    }

    findTempo(note) {
        while (note) {
            if (note.variables.tempo) {
                return note.getVariable('tempo');
            }
            note = this.getNoteById(note.parentId);
        }
        return this.baseNote.getVariable('tempo');
    }

    generateMeasures(fromNote, n) {
        const notes = [];

        for (let i = 0; i < n; i++) {
            const prevNote = i === 0 ? fromNote : this.getNoteById(notes[i - 1].id);
            const measureLength = this.findMeasureLength(prevNote);

            const newNote = this.addNote({
                startTime: () => prevNote.getVariable('startTime').add(measureLength),
            });
            newNote.parentId = prevNote.id;
            notes.push(newNote);
        }

        return notes;
    }

    static async loadFromJSON(jsonPath) {
        const response = await fetch(jsonPath);
        const data = await response.json();

        const baseNoteVariables = {
            frequency: () => eval(data.baseNote.frequency),
            startTime: () => eval(data.baseNote.startTime),
            tempo: () => eval(data.baseNote.tempo),
            beatsPerMeasure: () => eval(data.baseNote.beatsPerMeasure)
        };

        const module = new Module(baseNoteVariables);

        data.notes.forEach(noteData => {
            const variables = {};

            if (noteData.startTime) {
                variables.startTime = () => eval(noteData.startTime);
            }
            if (noteData.duration) {
                variables.duration = () => eval(noteData.duration);
            }
            if (noteData.frequency) {
                variables.frequency = () => eval(noteData.frequency);
                variables.frequencyString = noteData.frequency;
            }
            if (noteData.color) {
                variables.color = () => noteData.color;
            }

            module.addNote(variables);
        });

        return module;
    }
}