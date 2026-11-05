import siblingScenario, { contract as siblingContract } from './native-sibling-branches.mjs';

export const name = 'on-device-clone-lifecycle';
export const contract = {
  requiredPhases: [...siblingContract.requiredPhases.slice(0, 6), 'sibling-clone-stop'],
};

export default async function scenario(e2e) {
  return siblingScenario(e2e, { cloneOnly: true });
}
