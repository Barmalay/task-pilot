import type { Contour } from '../../packages/step-kit/src/index.ts';

/** Деплой контура берет ветку k8s-ansible задачи только из Customize Deploy (`deploy.ansibleBranch: customize` профиля контура). */
export const customizeOnly = (contour: Pick<Contour, 'deploy'> | undefined): boolean => contour?.deploy?.ansibleBranch === 'customize';
