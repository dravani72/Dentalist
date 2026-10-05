import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Res, Inject } from '@nestjs/common';
import type { Response } from 'express';
import { MediaUploadRequest } from '@teeth/shared';
import { z } from 'zod';
import { body } from '../common/http';
import { CurrentActor, Public } from '../auth/auth.guard';
import type { Actor } from '../auth/actor';
import { MediaService } from './media.service';

@Controller()
export class MediaController {
  constructor(@Inject(MediaService) private readonly media: MediaService) {}

  @Post('encounters/:id/media')
  upload(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(MediaUploadRequest)) req: z.infer<typeof MediaUploadRequest>) {
    return this.media.upload(actor, id, req);
  }

  @Get('media/:id/url')
  url(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.media.signedUrl(actor, id);
  }

  /** Short-lived signed link; the token is the authorization (it was issued to an audited, authorized session). */
  @Public()
  @Get('media/content/:signed')
  async content(@Param('signed') signed: string, @Res() res: Response) {
    const { contentType, data } = await this.media.content(signed);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    res.send(data);
  }
}
