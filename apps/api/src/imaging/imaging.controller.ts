import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ImagingReadRequest, ImagingUploadRequest } from '@teeth/shared';
import { body } from '../common/http';
import { CurrentActor, Public } from '../auth/auth.guard';
import type { Actor } from '../auth/actor';
import { ImagingService } from './imaging.service';

@Controller()
export class ImagingController {
  constructor(@Inject(ImagingService) private readonly imaging: ImagingService) {}

  @Post('encounters/:id/imaging-studies')
  upload(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(ImagingUploadRequest)) req: ImagingUploadRequest) {
    return this.imaging.upload(actor, id, req);
  }

  @Post('encounters/:id/imaging-reads')
  read(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(ImagingReadRequest)) req: ImagingReadRequest) {
    return this.imaging.recordRead(actor, id, req);
  }

  @Get('imaging-studies/:id/volume-url')
  volumeUrl(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.imaging.volumeUrl(actor, id);
  }

  @Get('imaging/unread')
  unread(@CurrentActor() actor: Actor) {
    return this.imaging.unread(actor);
  }

  /** Short-lived signed link; the token is the authorization (it was issued to an audited, authorized session). */
  @Public()
  @Get('imaging/volume/:signed')
  async volume(@Param('signed') signed: string, @Res() res: Response) {
    const data = await this.imaging.volumeContent(signed);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.send(data);
  }
}
