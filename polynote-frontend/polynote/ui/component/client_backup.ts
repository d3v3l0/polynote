import {clear, get, keys, set} from 'idb-keyval';
import {NotebookUpdate} from "../../data/messages";
import {NotebookCell, NotebookConfig} from "../../data/data";

export class ClientBackup {
    static addNb(path: string, cells: NotebookCell[], config?: NotebookConfig): Promise<Backups> {
        const clearedCells = cells.map(cell => new NotebookCell(cell.id, cell.language, cell.content, [], cell.metadata, cell.comments));
        const backup = new Backup(path, clearedCells, config);
        return get(path)
            .then((backupsObj?: IBackups) => {
                const backups: Backups = backupsObj ? Backups.fromI(backupsObj) : new Backups(path);
                if (backups.latestBackup()?.equals(backup)) {
                    return backups
                } else {
                    backups.addBackup(backup);

                    return set(path, backups.toI())
                        .then(() => {
                            console.log("Set backups for", path);
                            return backups
                        })
                        .catch(err => {
                            console.log("Error while setting backups", err);
                            throw err;
                        })
                }
            })
    }

    static getBackups(path: string): Promise<IBackups> {
        return get(path)
            .then((iBackups: IBackups) => {
                if (iBackups) {
                    return iBackups
                }
                throw new Error(`No Backup found for ${path}`)
            })
    }

    static allBackups(): Promise<Record<string, IBackups>> {
        return keys()
            .then(ks => {
                const backups: Record<string, IBackups> = {};
                return Promise.all(ks.map((k: string) =>
                    ClientBackup.getBackups(k)
                        .then(iBackup => {
                            backups[k] = iBackup;
                        })
                )).then(() => backups)
            })
    }

    static updateNb(path: string, upd: NotebookUpdate): Promise<Backups> {
        return get(path)
            .then((iBackups?: IBackups) => {
                if (iBackups) {
                    const backups = Backups.fromI(iBackups);
                    backups.addUpdate(upd);
                    return set(path, backups.toI())
                        .then(() => {
                            console.log("Updated backups for", path);
                            return backups
                        })
                        .catch(err => {
                            console.log("Error while updating backups", err);
                            throw err;
                        })
                }
                throw new Error(`Unable to find a current backup for notebook at ${path}`)
            })
    }

    static clearBackups() {
        return this.allBackups().then(backups => clear().then(() => backups))
    }
}

function todayTs() {
    return new Date().setHours(0,0,0,0);
}


export const BACKUPS_PER_NOTEBOOK = 100;
export const BACKUPS_PER_DAY = 10;

/**
 * Stores a set of backups for a particular notebook. Stores backups by day for a particular notebook.
 * Uses the above limits to determine how many backups to store.
 *
 * When the limits are reached:
 *     If the daily limit is reached, the oldest backup saved that day is replaced by the newest one.
 *     If the total limit is reached, the oldest day of backups is removed.
 */
interface IBackups {
    readonly path: string,
    readonly backups: Record<number, IBackup[]>
}

class Backups {

    constructor(readonly path: string, readonly backups: Record<number, Backup[]> = {}) {}

    addBackup(backup: Backup) {
        if (Object.values(this.backups).length > BACKUPS_PER_NOTEBOOK) {
            const oldestDay = Math.min(...Object.keys(this.backups).map(i => parseInt(i)));
            console.log("Reached total backup limit of", BACKUPS_PER_NOTEBOOK);
            console.log("Deleting backups from", new Date(oldestDay).toDateString());
            const oldestBackups = this.backups[oldestDay];
            console.log(oldestBackups);
            delete this.backups[oldestDay];
        }

        const todayBackups = this.backups[todayTs()];

        if (todayBackups === undefined) {
            this.backups[todayTs()] = [backup];
        } else if (this.backups[todayTs()].length < BACKUPS_PER_DAY) {
            this.backups[todayTs()].push(backup)
        } else {
            const removed = this.backups[todayTs()].shift();
            this.backups[todayTs()].push(backup);
            console.log("Reached backup limit of", BACKUPS_PER_DAY, "backups per day.");
            console.log("Removed an old backup from earlier today", removed);
        }
    }

    latestBackup() {
        // short-circuit if there are backups from today
        const todayBackups = this.backups[todayTs()];
        if (todayBackups) {
            return todayBackups[todayBackups.length - 1];
        } else {
            const newestDay = Math.max(...Object.keys(this.backups).map(i => parseInt(i)));
            const newestBackups = this.backups[newestDay];
            if (newestBackups) {
                return newestBackups[newestBackups.length - 1];
            } else {
                return undefined
            }
        }
    }

    addUpdate(upd: NotebookUpdate) {
        const latest = this.latestBackup();
        if (latest) {
            latest.addUpdate(upd);
        } else {
            throw new Error(`No backups found for ${this.path}!`)
        }
    }

    static fromI(iBackups: IBackups): Backups {
        const backups: Record<number, Backup[]> = {};
        Object.entries(iBackups.backups).forEach(([ts, iBackups]) => {
            backups[parseInt(ts)] = iBackups.map(Backup.fromI);
        });
        return new Backups(iBackups.path, backups)
    }

    toI(): IBackups {
        return {
            path: this.path,
            backups: this.backups
        }
    }
}

/**
 * Stores a particular backup of a notebook and edits to it from a given session.
 * Notebook outputs are not saved; only the content of the notebook is saved.
 */
interface IBackup {
    readonly path: string,
    readonly cells: NotebookCell[],
    readonly config?: NotebookConfig,
    readonly ts: number,
    readonly updates: {ts: number, upd: NotebookUpdate}[],
}
class Backup {

    constructor(readonly path: string,
                readonly cells: NotebookCell[],
                readonly config?: NotebookConfig,
                readonly ts: number = Date.now(),
                readonly updates: {ts: number, upd: NotebookUpdate}[] = []) {}

    addUpdate(upd: NotebookUpdate) {
        const ts = Date.now();
        this.updates.push({ts, upd});
    }

    static fromI(iBackup: IBackup): Backup {
        return new Backup(iBackup.path, iBackup.cells, iBackup.config, iBackup.ts, iBackup.updates)
    }

    equals(backup: Backup) {
        return this.path === backup.path
            && this.cells === backup.cells
            && this.config === backup.config
            && this.updates === backup.updates
    }
}

