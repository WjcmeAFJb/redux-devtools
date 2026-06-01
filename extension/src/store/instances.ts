import type { Reducer } from 'redux';
import { instances as coreInstances } from '@redux-devtools/app';
import type { InstancesState } from '@redux-devtools/app';

// Removes a SINGLE connected instance (one `window.__REDUX_DEVTOOLS_EXTENSION__
// .connect()` store) from the devtools — as opposed to the core REMOVE_INSTANCE,
// which drops a whole tab connection and every instance under it. Handled here in
// the extension rather than in the shared @redux-devtools/app reducer, so the
// background and panel stores (which both use the core `instances` reducer) stay
// in sync without forking the package.
export const REMOVE_SINGLE_INSTANCE = 'extension/REMOVE_SINGLE_INSTANCE';

export interface RemoveSingleInstanceAction {
  readonly type: typeof REMOVE_SINGLE_INSTANCE;
  readonly id: string | number;
}

function removeSingleInstance(
  state: InstancesState,
  id: string | number,
): InstancesState {
  // Find the connection (tab) that owns this instance id.
  const entry = Object.entries(state.connections).find(([, instanceIds]) =>
    instanceIds.includes(id),
  );
  if (!entry) return state;
  const [connectionId, instanceIds] = entry;

  // Drop just this instance from its connection, keeping any siblings.
  const connections = { ...state.connections };
  const remaining = instanceIds.filter((instanceId) => instanceId !== id);
  if (remaining.length) connections[connectionId] = remaining;
  else delete connections[connectionId];

  const options = { ...state.options };
  delete options[id];
  const states = { ...state.states };
  delete states[id];

  let selected = state.selected;
  let sync = state.sync;
  if (id === selected) {
    selected = null;
    sync = false;
  }

  // If the removed instance was current, fall back to any remaining instance
  // (or 'default' when none are left), mirroring the core removeState logic.
  let current = state.current;
  if (id === current) {
    const firstConnection = Object.keys(connections)[0];
    current = firstConnection ? connections[firstConnection][0] : 'default';
  }

  return { ...state, selected, current, sync, connections, options, states };
}

// Wraps the shared app-core `instances` reducer, intercepting only our
// single-instance removal and delegating everything else unchanged.
const instances: Reducer<InstancesState> = (state, action) => {
  if (state && action.type === REMOVE_SINGLE_INSTANCE) {
    return removeSingleInstance(
      state,
      (action as unknown as RemoveSingleInstanceAction).id,
    );
  }
  return coreInstances(state, action as Parameters<typeof coreInstances>[1]);
};

export default instances;
