import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

@WebSocketGateway({
  cors: {
    origin: '*',
  },
})
export class GameGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private rooms: Record<
    string,
    { moves: Record<string, string>; timer?: NodeJS.Timeout }
  > = {};

  private playAgainRequests: Record<string, Set<string>> = {};

  private confirmedPlayers: Record<string, Set<string>> = {};

  private clientRoomMap: Map<string, string> = new Map();

  handleConnection(client: Socket) {
    console.log('Client connected: ', client.id);
  }

  handleDisconnect(client: Socket) {
    console.log('Client disconnected: ', client.id);

    const roomId = this.clientRoomMap.get(client.id);

    if (roomId) {
      if (this.confirmedPlayers[roomId]) {
        this.confirmedPlayers[roomId].delete(client.id);

        if (this.confirmedPlayers[roomId].size === 0) {
          delete this.confirmedPlayers[roomId];
        } else {
          this.server.to(roomId).emit('playersConfirmed', {
            confirmed: Array.from(this.confirmedPlayers[roomId]),
          });
        }
      }
      if (this.playAgainRequests[roomId]) {
        this.playAgainRequests[roomId].delete(client.id);
        if (this.playAgainRequests[roomId].size === 0) {
          delete this.playAgainRequests[roomId];
        }
      }

      if (this.rooms[roomId]?.moves) {
        delete this.rooms[roomId].moves[client.id];
      }

      const players = Array.from(
        this.server.sockets.adapter.rooms.get(roomId) || [],
      );
      this.server.to(roomId).emit('playersUpdate', { players });

      this.clientRoomMap.delete(client.id);

      console.log(`Cliente ${client.id} removido de la sala ${roomId}`);
    }
  }
  @SubscribeMessage('joinRoom')
  handleJoinRoom(client: Socket, roomId: string) {
    const currentRoom = this.clientRoomMap.get(client.id);
    if (currentRoom && currentRoom !== roomId) {
      void client.leave(currentRoom);
      this.handleLeaveRoom(client, currentRoom);
    }

    void client.join(roomId);
    this.clientRoomMap.set(client.id, roomId);

    const players = Array.from(
      this.server.sockets.adapter.rooms.get(roomId) || [],
    );

    if (players.length > 2) {
      void client.leave(roomId);
      this.clientRoomMap.delete(client.id);
      client.emit('roomFull', { message: 'La sala está llena' });
      return;
    }

    if (!this.confirmedPlayers[roomId]) {
      this.confirmedPlayers[roomId] = new Set();
    }

    this.server.to(roomId).emit('playersUpdate', { players });
    this.server.to(roomId).emit('playerJoined', {
      playerId: client.id,
    });

    this.server.to(roomId).emit('playersConfirmed', {
      confirmed: Array.from(this.confirmedPlayers[roomId]),
    });

    console.log(`Sala ${roomId} ahora tiene jugadores:`, players);
  }

  @SubscribeMessage('leaveRoom')
  handleLeaveRoom(client: Socket, roomId: string) {
    void client.leave(roomId);

    if (this.confirmedPlayers[roomId]) {
      this.confirmedPlayers[roomId].delete(client.id);
      if (this.confirmedPlayers[roomId].size === 0) {
        delete this.confirmedPlayers[roomId];
      }
    }

    if (this.playAgainRequests[roomId]) {
      this.playAgainRequests[roomId].delete(client.id);
      if (this.playAgainRequests[roomId].size === 0) {
        delete this.playAgainRequests[roomId];
      }
    }

    if (this.rooms[roomId]?.moves) {
      delete this.rooms[roomId].moves[client.id];
    }

    this.clientRoomMap.delete(client.id);

    const players = Array.from(
      this.server.sockets.adapter.rooms.get(roomId) || [],
    );
    this.server.to(roomId).emit('playersUpdate', { players });

    if (this.confirmedPlayers[roomId]) {
      this.server.to(roomId).emit('playersConfirmed', {
        confirmed: Array.from(this.confirmedPlayers[roomId]),
      });
    }
  }
  @SubscribeMessage('confirmPlayer')
  handleConfirmPlayer(client: Socket, roomId: string) {
    if (!this.confirmedPlayers[roomId]) {
      this.confirmedPlayers[roomId] = new Set();
    }
    const roomPlayers = Array.from(
      this.server.sockets.adapter.rooms.get(roomId) || [],
    );

    if (!roomPlayers.includes(client.id)) {
      console.log(`Cliente ${client.id} no está en la sala ${roomId}`);
      return;
    }

    if (this.confirmedPlayers[roomId].has(client.id)) {
      console.log(`Cliente ${client.id} ya estaba confirmado`);
      return;
    }

    if (this.confirmedPlayers[roomId].size >= 2) {
      console.log(`Sala ${roomId} ya tiene 2 jugadores confirmados`);
      return;
    }

    this.confirmedPlayers[roomId].add(client.id);

    this.server.to(roomId).emit('playersConfirmed', {
      confirmed: Array.from(this.confirmedPlayers[roomId]),
    });

    console.log(`Jugador ${client.id} confirmó en la sala ${roomId}`);
    console.log(
      `Confirmados en sala ${roomId}:`,
      Array.from(this.confirmedPlayers[roomId]),
    );

    if (this.confirmedPlayers[roomId].size === 2 && roomPlayers.length === 2) {
      console.log(`Iniciando juego en sala ${roomId}`);
      this.confirmedPlayers[roomId].clear();
      this.server.to(roomId).emit('gameStart', { countdown: 3 });
    }
  }

  @SubscribeMessage('readyForRound')
  handleReadyForRound(client: Socket, data: { roomId: string }) {
    this.startRound(data.roomId);
  }

  startRound(roomId: string) {
    if (!this.rooms[roomId]) {
      this.rooms[roomId] = { moves: {} };
    }
    this.rooms[roomId].moves = {};

    const timeLimit = 10;
    const startAt = Date.now();

    this.server.to(roomId).emit('roundStart', { timeLimit, startAt });

    clearTimeout(this.rooms[roomId].timer);
    this.rooms[roomId].timer = setTimeout(() => {
      this.finishRound(roomId);
    }, 10000);
  }

  @SubscribeMessage('playerMove')
  handlePlayerMove(client: Socket, payload: { roomId: string; move: string }) {
    const { roomId, move } = payload;
    this.rooms[roomId].moves[client.id] = move;
    const numPlayers = this.server.sockets.adapter.rooms.get(roomId)?.size || 0;
    if (Object.keys(this.rooms[roomId].moves).length === numPlayers) {
      clearTimeout(this.rooms[roomId].timer);
      this.finishRound(roomId);
    }
  }

  @SubscribeMessage('playAgain')
  handlePlayAgain(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomId: string },
  ) {
    const { roomId } = data;

    this.rooms[roomId].moves = {};

    if (!this.playAgainRequests[roomId]) {
      this.playAgainRequests[roomId] = new Set<string>();
    }

    this.playAgainRequests[roomId].add(client.id);

    this.server.to(roomId).emit('playAgainStatus', {
      confirmed: Array.from(this.playAgainRequests[roomId]),
    });

    const players = Array.from(
      this.server.sockets.adapter.rooms.get(roomId) || [],
    );
    if (this.playAgainRequests[roomId].size === players.length) {
      setTimeout(() => {
        client.emit('playAgainConfirmed');
        this.playAgainRequests[roomId].clear();
        this.server.to(roomId).emit('rematch', { countdown: 3 });
      }, 200);
    } else {
      client.emit('waitingForPlayers');
    }
  }

  finishRound(roomId: string) {
    const moves = this.rooms[roomId].moves;

    const room = this.rooms[roomId];
    if (!room) {
      return;
    }

    const players = Array.from(
      this.server.sockets.adapter.rooms.get(roomId) || [],
    );

    for (const playerId of players) {
      if (!room.moves[playerId]) {
        const randomMove = this.getRandomMove();
        room.moves[playerId] = randomMove;
        this.server.to(playerId).emit('autoMove', { move: randomMove });
      }
    }

    const numplayers = Object.keys(moves);
    let result: any = { players: [] };

    if (numplayers.length === 2) {
      const [p1, p2] = numplayers;
      const m1 = moves[p1];
      const m2 = moves[p2];

      let winner: string | null = null;

      if (m1 === m2) {
        winner = null;
      } else if (
        (m1 === 'piedra' && m2 === 'tijera') ||
        (m1 === 'papel' && m2 === 'piedra') ||
        (m1 === 'tijera' && m2 === 'papel')
      ) {
        winner = p1;
      } else {
        winner = p2;
      }

      result = {
        players: [
          { id: p1, userName: 'Jugador 1', move: m1 },
          { id: p2, userName: 'Jugador 2', move: m2 },
        ],
        winner,
      };
    }

    this.server.to(roomId).emit('roundEnd', result);
  }

  private getRandomMove() {
    const moves = ['piedra', 'papel', 'tijera'];
    const randomIndex = Math.floor(Math.random() * moves.length);
    return moves[randomIndex];
  }
}
