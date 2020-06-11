/**
 * The Dispatcher is used to handle actions initiated by the UI.
 * It knows whether an Action should be translated to a message and then sent on the socket, or if it should be
 * handled by something else.
 */
import match from "../../../util/match";
import * as messages from "../../../data/messages";
import {CellComment, CellMetadata, NotebookCell, NotebookConfig} from "../../../data/data";
import {Output, PosRange} from "../../../data/result";
import {StateHandler} from "../state/state_handler";
import {CompletionHint, NotebookState, NotebookStateHandler, SignatureHint} from "../state/notebook_state";
import {ContentEdit} from "../../../data/content_edit";
import {ServerState, ServerStateHandler} from "../state/server_state";
import {SocketStateHandler} from "../state/socket_state";
import {EphemeralStateHandler} from "../state/ephemeral_state";

export abstract class MessageDispatcher<S> {
    protected constructor(protected socket: SocketStateHandler, protected state: StateHandler<S>) {}

    abstract dispatch(action: UIAction): void
}

export class NotebookMessageDispatcher extends MessageDispatcher<NotebookState>{
    constructor(socket: SocketStateHandler, state: NotebookStateHandler) {
        super(socket, state);
        // when the socket is opened, send a KernelStatus message to request the current status from the server.
        socket.view("status").addObserver(next => {
            if (next === "connected") {
                socket.send(new messages.KernelStatus(new messages.KernelBusyState(false, false)))
            }
        });
    }

    dispatch(action: UIAction) {
        match(action)
            .when(Reconnect, (onlyIfClosed: boolean) => {
                this.socket.reconnect(onlyIfClosed)
            })
            .when(KernelCommand, (command: string) => {
                if (command === "start") {
                    this.socket.send(new messages.StartKernel(messages.StartKernel.NoRestart));
                } else if (command === "kill") {
                    if (confirm("Kill running kernel? State will be lost.")) {
                        this.socket.send(new messages.StartKernel(messages.StartKernel.Kill));
                    }
                }
            })
            .when(CreateComment, (cellId, comment) => {
                const state = this.state.getState()
                this.socket.send(new messages.CreateComment(state.globalVersion, state.localVersion, cellId, comment))
            })
            .when(UpdateComment, (cellId, commentId, range, content) => {
                const state = this.state.getState()
                this.socket.send(new messages.UpdateComment(state.globalVersion, state.localVersion, cellId, commentId, range, content))
            })
            .when(DeleteComment, (cellId, commentId) => {
                const state = this.state.getState()
                this.socket.send(new messages.DeleteComment(state.globalVersion, state.localVersion, cellId, commentId))
            })
            .when(SetCurrentSelection, (cellId, range) => {
                this.socket.send(new messages.CurrentSelection(cellId, range))
            })
            .when(SetCellOutput, (cellId, output) => {
                const state = this.state.getState()
                this.socket.send(new messages.SetCellOutput(state.globalVersion, state.localVersion, cellId, output))
            })
            .when(SetCellLanguage, (cellId, language) => {
                this.state.updateState(state => {
                    this.socket.send(new messages.SetCellLanguage(state.globalVersion, state.localVersion, cellId, language))
                    return {
                        ...state,
                        cells: state.cells.map(cell => {
                            if (cell.id === cellId) {
                                return {...cell, language: language}
                            } else return cell
                        })
                    }
                })
            })
            .when(CreateCell, (language, content, metadata, prev) => {
                this.state.updateState(state => {
                    let localVersion = state.localVersion + 1;
                    // generate the max ID here. Note that there is a possible race condition if another client is inserting a cell at the same time.
                    const maxId = state.cells.reduce((acc, cell) => acc > cell.id ? acc : cell.id, -1)
                    const cell = new NotebookCell(maxId + 1, language, content, [], metadata);
                    const update = new messages.InsertCell(state.globalVersion, localVersion, cell, prev);
                    this.socket.send(update);
                    return {
                        ...state,
                        editBuffer: state.editBuffer.push(state.localVersion, update)
                    }
                })
            })
            .when(UpdateCell, (cellId, edits, newContent, metadata) => {
                this.state.updateState(state => {
                    let localVersion = state.localVersion + 1;
                    const update = new messages.UpdateCell(state.globalVersion, localVersion, cellId, edits, metadata);
                    this.socket.send(update);
                    return {
                        ...state,
                        editBuffer: state.editBuffer.push(state.localVersion, update),
                        cells: state.cells.map(cell => {
                            if (cell.id === cellId) {
                                return {...cell, content: newContent ?? cell.content, metadata: metadata ?? cell.metadata}
                            } else return cell
                        })
                    }
                })
            })
            .when(DeleteCell, (cellId) => {
                this.state.updateState(state => {
                    state = {...state}
                    const update = new messages.DeleteCell(state.globalVersion, ++state.localVersion, cellId);
                    this.socket.send(update);
                    state.editBuffer = state.editBuffer.push(state.localVersion, update)
                    return state
                })
            })
            .when(UpdateConfig, conf => {
                this.state.updateState(state => {
                    state = {...state}
                    const update = new messages.UpdateConfig(state.globalVersion, ++state.localVersion, conf);
                    this.socket.send(update);
                    state.editBuffer = state.editBuffer.push(state.localVersion, update)
                    return state
                })
            })
            .when(RequestCompletions, (cellId, offset, resolve, reject) => {
                this.socket.send(new messages.CompletionsAt(cellId, offset, []));
                this.state.updateState(state => {
                    if (state.activeCompletion) {
                        state.activeCompletion.reject();
                    }
                    return {
                        ...state,
                        activeCompletion: {resolve, reject}
                    }
                })
            })
            .when(RequestSignature, (cellId, offset, resolve, reject) => {
                this.socket.send(new messages.ParametersAt(cellId, offset));
                this.state.updateState(state => {
                    if (state.activeSignature) {
                        state.activeSignature.reject();
                    }
                    return {
                        ...state,
                        activeSignature: {resolve, reject}
                    }
                })
            })
            .when(RequestNotebookVersion, version => {
                const state = this.state.getState()
                this.socket.send(new messages.NotebookVersion(state.path, version))
            })
            .when(RequestCellRun, cellIds => {
                //TODO: what about client interpreters?
                this.state.updateState(state => {
                    // empty cellIds means run all of them!
                    if (cellIds.length === 0) {
                        cellIds = state.cells.map(cell => cell.id);
                    }
                    this.socket.send(new messages.RunCell(cellIds));
                    return {
                        ...state,
                        cells: state.cells.map(cell => {
                            if (cellIds.includes(cell.id)) {
                                return { ...cell, queued: true, results: [], error: false }
                            } else return cell
                        })
                    }
                })
            })
            .when(RequestCancelTasks, () => {
                const state = this.state.getState()
                this.socket.send(new messages.CancelTasks(state.path))
            })
            .when(RequestClearOutput, () => {
                this.socket.send(new messages.ClearOutput())
            })
            .when(SetSelectedCell, (selected, relative) => {
                this.state.updateState(state => {
                    let id = selected;
                    if (relative === "above")  {
                        const anchorIdx = state.cells.findIndex(cell => cell.id === id);
                        id = state.cells[anchorIdx - 1]?.id;
                    } else if (relative === "below") {
                        const anchorIdx = state.cells.findIndex(cell => cell.id === id);
                        id = state.cells[anchorIdx + 1]?.id;
                    }
                    id = id ?? (selected === -1 ? 0 : selected); // if "above" or "below" don't exist, just select `selected`.
                    return {
                        ...state,
                        activeCell: state.cells.find(cell => cell.id === id),
                        cells: state.cells.map(cell => {
                            return {
                                ...cell,
                                selected: cell.id === id
                            }
                        })
                    }
                })
            })
            .when(CurrentSelection, (cellId, range) => {
                this.socket.send(new messages.CurrentSelection(cellId, range));
                this.state.updateState(state => {
                    return {
                        ...state,
                        cells: state.cells.map(cell => {
                            // todo: what is this used for?
                            return {
                                ...cell,
                                currentSelection: cell.id === cellId ? range : undefined
                            }
                        })
                    }
                })
            })
            .when(ClearCellEdits, id => {
                this.state.updateState(state => {
                    return {
                        ...state,
                        cells: state.cells.map(cell => {
                            if (cell.id === id) {
                                return {
                                    ...cell,
                                    pendingEdits: []
                                }
                            } else return cell
                        })
                    }
                })
            })
            .when(DownloadNotebook, () => {
                // TODO download current notebook
            })
        // TODO: add more actions! basically UIEvents that anything subscribes to should be here I think
    }

    // Helper methods
    /**
     * Helper for inserting a cell.
     *
     * @param direction  Whether to insert below of above the anchor
     * @param anchor     The anchor. If it is undefined, the anchor is based on the currently selected cell. If none is
     *                   selected, the anchor is either the first or last cell (depending on the direction supplied).
     *                   The anchor is used to determine the location, language, and metadata to supply to the new cell.
     */
    insertCell(direction: 'above' | 'below', anchor?: {id: number, language: string, metadata: CellMetadata}) {
        const currentState = this.state.getState();
        let currentCell = currentState.activeCell;
        if (anchor === undefined) {
            if (currentCell === undefined) {
                if (direction === 'above') {
                    currentCell = currentState.cells[0];
                } else {
                    currentCell = currentState.cells[currentState.cells.length - 1];
                }
            }
            anchor = {id: currentCell.id, language: currentCell.language, metadata: currentCell.metadata};
        }
        const anchorIdx = currentState.cells.findIndex(cell => cell.id === anchor!.id);
        const prevIdx = direction === 'above' ? anchorIdx - 1 : anchorIdx;
        const maybePrev = currentState.cells[prevIdx];
        this.dispatch(new CreateCell(anchor.language, '', anchor.metadata, maybePrev.id))
    }

    deleteCell(id?: number){
       if (id === undefined) {
           id = this.state.getState().activeCell?.id;
       }
       if (id !== undefined) {
           this.dispatch(new DeleteCell(id));
       }
    }

    runActiveCell() {
        const id = this.state.getState().activeCell?.id;
        if (id !== undefined) {
            this.dispatch(new RequestCellRun([id]));
        }
    }

    runToActiveCell() {
        const state = this.state.getState();
        const id = state.activeCell?.id;
        const activeIdx = state.cells.findIndex(cell => cell.id === id);
        const cellsToRun = state.cells.splice(0, activeIdx).map(c => c.id);
        if (cellsToRun.length > 0) {
            this.dispatch(new RequestCellRun(cellsToRun))
        }
    }
}

export class ServerMessageDispatcher extends MessageDispatcher<ServerState>{
    constructor(socket: SocketStateHandler) {
        super(socket, ServerStateHandler.get);

    }

    dispatch(action: UIAction): void {
        this.state.updateState(s => {
            let newS: ServerState | undefined = undefined;
            match(action)
                .when(RequestNotebooksList, () => {
                    this.socket.send(new messages.ListNotebooks([]))
                })
                .when(LoadNotebook, path => {
                    let notebooks = s.notebooks
                    if (! s.notebooks[path])  {
                        notebooks = {...notebooks, [path]: ServerStateHandler.loadNotebook(path).loaded}
                    }
                    newS = {
                        ...s,
                        currentNotebook: path,
                        notebooks: notebooks
                    };
                })
                .when(CreateNotebook, (path, content) => {
                    this.socket.send(new messages.CreateNotebook(path, content))
                })
                .when(RenameNotebook, (oldPath, newPath) => {
                    this.socket.send(new messages.RenameNotebook(oldPath, newPath))
                })
                .when(CopyNotebook, (oldPath, newPath) => {
                    this.socket.send(new messages.CopyNotebook(oldPath, newPath))
                })
                .when(DeleteNotebook, (path) => {
                    this.socket.send(new messages.DeleteNotebook(path))
                })
                .when(ViewAbout, section => {
                    EphemeralStateHandler.get.updateState(e => {
                        return {
                            ...e,
                            about: section
                        }
                    })
                })
                .when(SetSelectedNotebook, path => {
                    newS = {
                        ...s,
                        currentNotebook: path
                    }
                })

            if (newS) return newS
            else return s
        });
    }
}

export class UIAction {
    static unapply(inst: UIAction): any[] {return []}

    constructor(...args: any[]) {}
}

export class KernelCommand extends UIAction {
    constructor(readonly command: "start" | "kill") { super() }

    static unapply(inst: KernelCommand): ConstructorParameters<typeof KernelCommand> {
        return [inst.command]
    }
}

export class Reconnect extends UIAction {
    constructor(readonly onlyIfClosed: boolean) { super() }

    static unapply(inst: Reconnect): ConstructorParameters<typeof Reconnect> {
        return [inst.onlyIfClosed]
    }
}


export class CreateComment extends UIAction {
    constructor(readonly cellId: number, readonly comment: CellComment) {
        super();
        Object.freeze(this);
    }

    static unapply(inst: CreateComment): ConstructorParameters<typeof CreateComment> {
        return [inst.cellId, inst.comment];
    }
}

export class UpdateComment extends UIAction {
    constructor(readonly cellId: number, readonly commentId: string, readonly range: PosRange, readonly content: string) {
        super();
        Object.freeze(this);
    }

    static unapply(inst: UpdateComment): ConstructorParameters<typeof UpdateComment> {
        return [inst.cellId, inst.commentId, inst.range, inst.content];
    }
}

export class DeleteComment extends UIAction {
    constructor(readonly cellId: number, readonly commentId: string) {
        super();
        Object.freeze(this);
    }

    static unapply(inst: DeleteComment): ConstructorParameters<typeof DeleteComment> {
        return [inst.cellId, inst.commentId];
    }
}

export class CreateCell extends UIAction {
    constructor(readonly language: string, readonly content: string, readonly metadata: CellMetadata, readonly prev: number) {
        super();
        Object.freeze(this);
    }

    static unapply(inst: CreateCell): ConstructorParameters<typeof CreateCell> {
        return [inst.language, inst.content, inst.metadata, inst.prev];
    }
}

export class UpdateCell extends UIAction {
    constructor(readonly cellId: number, readonly edits: ContentEdit[], readonly newContent?: string, readonly metadata?: CellMetadata) {
        super();
        Object.freeze(this);
    }

    static unapply(inst: UpdateCell): ConstructorParameters<typeof UpdateCell> {
        return [inst.cellId, inst.edits, inst.newContent, inst.metadata];
    }
}

export class DeleteCell extends UIAction {
    constructor(readonly cellId: number) {
        super();
        Object.freeze(this);
    }

    static unapply(inst: DeleteCell): ConstructorParameters<typeof DeleteCell> {
        return [inst.cellId];
    }
}

export class UpdateConfig extends UIAction {
    constructor(readonly config: NotebookConfig) {
        super();
        Object.freeze(this);
    }

    static unapply(inst: UpdateConfig): ConstructorParameters<typeof UpdateConfig> {
        return [inst.config];
    }
}

export class LoadNotebook extends UIAction {
    constructor(readonly path: string) {
        super();
        Object.freeze(this);
    }

    static unapply(inst: LoadNotebook): ConstructorParameters<typeof LoadNotebook> {
        return [inst.path];
    }
}


export class CreateNotebook extends UIAction {
    constructor(readonly path: string, readonly content?: string) {
        super();
        Object.freeze(this);
    }

    static unapply(inst: CreateNotebook): ConstructorParameters<typeof CreateNotebook> {
        return [inst.path, inst.content];
    }
}

export class RenameNotebook extends UIAction {
    constructor(readonly oldPath: string, readonly newPath: string) {
        super();
        Object.freeze(this);
    }

    static unapply(inst: RenameNotebook): ConstructorParameters<typeof RenameNotebook> {
        return [inst.oldPath, inst.newPath];
    }
}

export class CopyNotebook extends UIAction {
    constructor(readonly oldPath: string, readonly newPath: string) {
        super();
        Object.freeze(this);
    }

    static unapply(inst: CopyNotebook): ConstructorParameters<typeof CopyNotebook> {
        return [inst.oldPath, inst.newPath];
    }
}

export class DeleteNotebook extends UIAction {
    constructor(readonly path: string) {
        super();
        Object.freeze(this);
    }

    static unapply(inst: DeleteNotebook): ConstructorParameters<typeof DeleteNotebook> {
        return [inst.path];
    }
}

export class SetCurrentSelection extends UIAction {
    constructor(readonly cellId: number, readonly range: PosRange) {
        super();
        Object.freeze(this);
    }

    static unapply(inst: SetCurrentSelection): ConstructorParameters<typeof SetCurrentSelection> {
        return [inst.cellId, inst.range];
    }
}

export class SetCellOutput extends UIAction {
    constructor(readonly cellId: number, readonly output: Output) {
        super();
        Object.freeze(this);
    }

    static unapply(inst: SetCellOutput): ConstructorParameters<typeof SetCellOutput> {
        return [inst.cellId, inst.output];
    }
}

export class SetCellLanguage extends UIAction {
    constructor(readonly cellId: number, readonly language: string) {
        super();
        Object.freeze(this);
    }

    static unapply(inst: SetCellLanguage): ConstructorParameters<typeof SetCellLanguage> {
        return [inst.cellId, inst.language];
    }
}

export class RequestCompletions extends UIAction {
    constructor(readonly cellId: number, readonly offset: number,
                readonly resolve: (completion: CompletionHint) => void, readonly reject: () => void) {
        super();
        Object.freeze(this);
    }

    static unapply(inst: RequestCompletions): ConstructorParameters<typeof RequestCompletions> {
        return [inst.cellId, inst.offset, inst.resolve, inst.reject];
    }
}

export class RequestSignature extends UIAction {
    constructor(readonly cellId: number, readonly offset: number,
                readonly resolve: (value: SignatureHint) => void, readonly reject: () => void) {
        super();
        Object.freeze(this);
    }

    static unapply(inst: RequestSignature): ConstructorParameters<typeof RequestSignature> {
        return [inst.cellId, inst.offset, inst.resolve, inst.reject];
    }
}

export class RequestNotebookVersion extends UIAction {
    constructor(readonly version: number) {
        super();
        Object.freeze(this);
    }

    static unapply(inst: RequestNotebookVersion): ConstructorParameters<typeof RequestNotebookVersion> {
        return [inst.version];
    }
}

export class RequestCellRun extends UIAction {
    constructor(readonly cells: number[]) {
        super();
        Object.freeze(this);
    }

    static unapply(inst: RequestCellRun): ConstructorParameters<typeof RequestCellRun> {
        return [inst.cells];
    }
}

export class RequestCancelTasks extends UIAction {
    constructor() {
        super();
        Object.freeze(this);
    }

    static unapply(inst: RequestCancelTasks): ConstructorParameters<typeof RequestCancelTasks> {
        return [];
    }
}

export class RequestClearOutput extends UIAction {
    constructor() {
        super();
        Object.freeze(this);
    }

    static unapply(inst: RequestClearOutput): ConstructorParameters<typeof RequestClearOutput> {
        return [];
    }
}

export class RequestNotebooksList extends UIAction {
    constructor() {
        super();
        Object.freeze(this);
    }

    static unapply(inst: RequestNotebooksList): ConstructorParameters<typeof RequestNotebooksList> {
        return [];
    }
}

export class SetSelectedCell extends UIAction {
    /**
     * Change the currently selected cell.
     *
     * @param selected  The ID of the cell to select OR the ID of the anchor cell for `relative`. If `undefined`, deselects cells.
     * @param relative  If set, select the cell either above or below the one with ID specified by `selected`
     */
    constructor(readonly selected: number | undefined, readonly relative?: "above" | "below") {
        super();
        Object.freeze(this);
    }

    static unapply(inst: SetSelectedCell): ConstructorParameters<typeof SetSelectedCell> {
        return [inst.selected, inst.relative];
    }
}

export class CurrentSelection extends UIAction {
    constructor(readonly cellId: number, readonly range: PosRange) {
        super();
        Object.freeze(this);
    }

    static unapply(inst: CurrentSelection): ConstructorParameters<typeof CurrentSelection> {
        return [inst.cellId, inst.range];
    }
}

export class ClearCellEdits extends UIAction {
    constructor(readonly cellId: number) {
        super();
        Object.freeze(this);
    }

    static unapply(inst: ClearCellEdits): ConstructorParameters<typeof ClearCellEdits> {
        return [inst.cellId];
    }
}

export class DownloadNotebook extends UIAction {
    constructor() {
        super();
        Object.freeze(this);
    }

    static unapply(inst: DownloadNotebook): ConstructorParameters<typeof DownloadNotebook> {
        return [];
    }
}

export class SetSelectedNotebook extends UIAction {
    constructor(readonly path?: string) {
        super();
        Object.freeze(this);
    }

    static unapply(inst: SetSelectedNotebook): ConstructorParameters<typeof SetSelectedNotebook> {
        return [inst.path];
    }
}

export class ViewAbout extends UIAction {
    constructor(readonly section: string) {
        super();
        Object.freeze(this);
    }

    static unapply(inst: ViewAbout): ConstructorParameters<typeof ViewAbout> {
        return [inst.section];
    }
}
