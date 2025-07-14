import { Application, Assets, Sprite, Graphics, ColorSource } from "pixi.js";
import { Input } from '@pixi/ui';
import { createClient } from '@supabase/supabase-js';

type RemotePenguin = {
  sprite: Sprite;
  targetX: number;
  targetY: number;
};

const pengSize = 200;
const moveSpeed = 5;
const sendInterval = 200; // send updates to broadcast channel every _ ms
var lastUpdated = 0; // enforcing delayed updates broadcast
var lastPos = { x: 100, y: 100}

const texture = await Assets.load("/assets/penguin.png");
const bg = await Assets.load("/assets/penguin_bg.png")
const SUPABASE_URL = 'https://rzhiuqoufzpfqxkjdchc.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ6aGl1cW91ZnpwZnF4a2pkY2hjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTI0MjI0NzksImV4cCI6MjA2Nzk5ODQ3OX0.sbtFaHYVtmHe9capbu2q8WYln8nd7_QpDZunA3YOwfM';
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);


// helper func to create sprites on canvas
function createPenguin(x: number, y: number, color: ColorSource) {
  const p = new Sprite(texture);
  p.width = pengSize;
  p.height = pengSize;
  p.anchor.set(0.5);
  p.position.set(x, y);
  const b = new Sprite(bg);
  b.anchor.set(0.5);
  b.tint = color;
  p.addChild(b);
  return p;
}

// create PixiJS app
const app = new Application();
await app.init({ background: "#b8edff", resizeTo: window });
document.getElementById("pixi-container")!.appendChild(app.canvas);

// set up players
const otherPlayers: Record<string, RemotePenguin> = {};
const player = { id: '', username: '',  color: '', x_pos: 0, y_pos: 0 };
const myPeng = createPenguin(100, 100, 'blue');

// text field for penguin username
const usernameIn = new Input({
  bg: new Graphics().roundRect(0, 0, 300, 60, 8.0).fill("#FFFFFF"),
  placeholder: 'Enter username', align: 'center',
  padding: 10
});
app.stage.addChild(usernameIn);

usernameIn.onEnter.connect((val) => { tryPenguinLogin(val); });
async function tryPenguinLogin(username: string) {
  const { data: newPeng, error } = await sb.from('penguin')
    .insert({ username: username, color: 'blue' })
    .select().maybeSingle()
  if (error != null) {
    console.log("Error creating new peng: " + JSON.stringify(error))
  } else {
    player.id = newPeng.id
    player.username = newPeng.username
    player.color = newPeng.color
  
    console.log("Successfully logged in as " + player.username);
    app.stage.removeChild(usernameIn);
    app.stage.addChild(myPeng);

    // load current penguins to draw
    const { data: currPengs, error } = await sb
      .from('penguin').select('*')
      .neq('id', player.id)

    if (error != null) { 
      console.error("Error loading pengs: " + JSON.stringify(error));
    }
    currPengs?.forEach((peng) => {
      const other = createPenguin(peng.x_pos, peng.y_pos, peng.color);
      app.stage.addChild(other);
      otherPlayers[peng.id] = {sprite: other, targetX: peng.x_pos, targetY: peng.y_pos };
    });

    connectToMainRoom();
  }
}

// actually connect application
function connectToMainRoom() {
  sb.channel('movement').on('broadcast', { event: 'move' }, (payload) => {
    const { id, color, x, y } = payload.payload;
    if (id === player.id) return; // ignore, since we update our own peng locally
    if (!otherPlayers[id]) {
      const other = createPenguin(x, y, color);
      app.stage.addChild(other);
      otherPlayers[id] = { sprite: other, targetX: x, targetY: y };
    } else {
      otherPlayers[id].targetX = x;
      otherPlayers[id].targetY = y;
    }
  })
  .subscribe();

  sb.channel('peng_room').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'penguin' }, payload => {
    const { new: newPeng } = payload;
    const other = createPenguin(newPeng.x_pos, newPeng.y_pos, newPeng.color);
    app.stage.addChild(other);
    otherPlayers[newPeng.id] = { sprite: other, targetX: newPeng.x_pos, targetY: newPeng.y_pos };
  })
  .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'penguin' }, payload => {
    const { old: oldPeng } = payload;
    app.stage.removeChild(otherPlayers[oldPeng.id].sprite);
  })
  .subscribe()

  // Movement input
  const keys: Record<string, boolean> = {};
  window.addEventListener('keydown', (e) => (keys[e.key] = true));
  window.addEventListener('keyup', (e) => (keys[e.key] = false));

  // local update loop
  app.ticker.add(() => {
    let moved = false;
    if (keys['ArrowUp']) {
      myPeng.y = Math.max(myPeng.y - moveSpeed, 0);
      moved = true;
    }
    if (keys['ArrowDown']) {
      myPeng.y = Math.min(myPeng.y + moveSpeed, app.screen.height);
      moved = true;
    }
    if (keys['ArrowLeft']) {
      myPeng.x = Math.max(myPeng.x - moveSpeed, 0);
      moved = true;
    }
    if (keys['ArrowRight']) {
      myPeng.x = Math.min(myPeng.x + moveSpeed, app.screen.width);
      moved = true;
    }

    // add delay to updates so listeners don't get overwhelmed
    const now = Date.now()
    if ((moved || !(lastPos.x == myPeng.x && lastPos.y == myPeng.y)) && now - lastUpdated > sendInterval) {
      lastUpdated = now;
      lastPos.x = myPeng.x;
      lastPos.y = myPeng.y;
      sb.channel('movement').send({
        type: 'broadcast', event: 'move',
        payload: {
          id: player.id, color: player.color,
          x: myPeng.x, y: myPeng.y,
        },
      });
      updateStoredPosition();
    }

    // linear interpolate to update positions
    for (const id in otherPlayers) {
      const player = otherPlayers[id];
      const dx = player.targetX - player.sprite.x;
      const dy = player.targetY - player.sprite.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= moveSpeed) {
        // snap to target if close enough
        player.sprite.x = player.targetX;
        player.sprite.y = player.targetY;
      } else {
        player.sprite.x += (dx / dist) * moveSpeed;
        player.sprite.y += (dy / dist) * moveSpeed;
      }
    }
  });
}

async function updateStoredPosition() {
  // also update table
  await sb.from('penguin')
    .update({ x_pos: myPeng.x, y_pos: myPeng.y})
    .eq('id', player.id)

}


window.onbeforeunload = function() {
  const params = new URLSearchParams({ peng_id: player.id });
  fetch('https://rzhiuqoufzpfqxkjdchc.supabase.co/functions/v1/delete-peng', {
    method: 'POST',
    body: params,
    keepalive: true,
  });
};