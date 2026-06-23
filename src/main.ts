import './style.css';
import { Game } from './Game';

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const overlay = document.getElementById('overlay') as HTMLDivElement;
const startBtn = document.getElementById('startBtn') as HTMLButtonElement;
const restartBtn = document.getElementById('restartBtn') as HTMLButtonElement;

const game = new Game(canvas);

startBtn.addEventListener('click', () => {
  overlay.classList.add('hidden');
  game.start();
});

restartBtn.addEventListener('click', () => {
  game.restart();
});
