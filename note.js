class Note {
    constructor(id, variables = {}) {
        this.id = id;
        this.variables = {};
        
        Object.entries(variables).forEach(([key, value]) => {
            this.variables[key] = value;
        });
    }

    setVariable(name, func) {
        this.variables[name] = func;
    }

    getVariable(name) {
        if (this.variables[name]) {
            return this.variables[name]();
        }
        return null;
    }

    getAllVariables() {
        const evaluatedVariables = {};
        for (const name of Object.keys(this.variables)) {
            if (name === 'frequencyString') {
                evaluatedVariables[name] = this.variables[name];
            } else {
                evaluatedVariables[name] = this.getVariable(name);
            }
        }
        return evaluatedVariables;
    }
}