import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { GameGateway } from './game/game.gateway';

@Module({
  imports: [GameGateway],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
