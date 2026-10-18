/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { CardsS5 } from './CardsS5';
import { FilmS5 } from './FilmS5';

/** S5's backdrop: the first screen's film under its frame, and the scene cards behind the rest of the page. */
export function SceneS5() {
  return <><FilmS5 /><CardsS5 /></>;
}
