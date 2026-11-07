import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import XLSX from "xlsx";
import { prisma } from "./db.js";
import { authenticate, requireAdmin } from "./middleware/auth.js";
import { audit } from "./utils/audit.js";

const app=express(), port=Number(process.env.PORT||4000);
const uploadDir=path.resolve(process.env.UPLOAD_DIR||"./private-uploads"); fs.mkdirSync(uploadDir,{recursive:true});
app.use(helmet({crossOriginResourcePolicy:{policy:"cross-origin"}}));
app.use(cors({origin:process.env.CORS_ORIGIN?.split(",")||true})); app.use(express.json({limit:"2mb"}));
app.use(express.static(path.resolve("./public")));
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:25*1024*1024},fileFilter:(_r,f,cb)=>cb(null,/^(image\/(jpeg|png|webp)|application\/pdf|application\/vnd\.openxmlformats-officedocument\.(spreadsheetml\.sheet|wordprocessingml\.document)|application\/msword|application\/vnd\.ms-excel)$/.test(f.mimetype))});
const uploadOne=(req,res,next)=>upload.single("file")(req,res,e=>e?res.status(400).json({error:e.message||"Upload failed"}):next());
const signToken=u=>jwt.sign({sub:u.id,role:u.role},process.env.JWT_SECRET,{expiresIn:"12h"});
const cleanUser=({passwordHash,...u})=>u;
const safeName=s=>String(s||"store").normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-zA-Z0-9]+/g,"_").replace(/^_|_$/g,"").slice(0,70)||"Store";
const dateOnly=d=>new Date(`${String(d).slice(0,10)}T00:00:00.000Z`);
const dateString=d=>new Date(d||Date.now()).toISOString().slice(0,10);
const storeScope=(u,id)=>u.role==="SUPER_ADMIN"?(id||undefined):(u.storeId||"__none__");
app.get("/api/health",(_q,s)=>s.json({status:"ok",service:"Paper Work"}));
app.post("/api/auth/login",async(req,res)=>{const {email,password}=req.body||{};const u=await prisma.user.findUnique({where:{email:String(email||"").toLowerCase().trim()}});if(!u||!u.active||!(await bcrypt.compare(String(password||""),u.passwordHash)))return res.status(401).json({error:"Invalid login credentials"});res.json({token:signToken(u),user:cleanUser(u)});});
app.use("/api",(req,res,next)=>req.path==="/drive/callback"?next():authenticate(req,res,next));
app.get("/api/auth/me",(req,res)=>res.json({user:req.user}));
app.get("/api/stores",async(req,res)=>{const where=req.user.role==="SUPER_ADMIN"?{}:{id:req.user.storeId||"__none__"};const stores=await prisma.store.findMany({where,include:{_count:{select:{documents:true}}},orderBy:{name:"asc"}});res.json(stores);});
app.post("/api/stores",requireAdmin,async(req,res)=>{
 const name=String(req.body?.name||"").trim();
 if(!name)return res.status(400).json({error:"Store name is required"});
 // Reject duplicate names (case-insensitive) so repeated submissions cannot create twins.
 const duplicate=await prisma.store.findFirst({where:{name:{equals:name,mode:"insensitive"}}});
 if(duplicate)return res.status(409).json({error:`A store named "${duplicate.name}" already exists.`});
 const code=`PW-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
 const store=await prisma.store.create({data:{name,code}});
 await audit({actorId:req.user.id,action:"CREATE",entityType:"Store",entityId:store.id,after:store});
 res.status(201).json(store);
});
app.patch("/api/stores/:id",requireAdmin,async(req,res)=>{const before=await prisma.store.findUnique({where:{id:req.params.id}});if(!before)return res.status(404).json({error:"Store not found"});const data={};if(req.body.name!==undefined){const name=String(req.body.name).trim();if(!name)return res.status(400).json({error:"Store name is required"});const duplicate=await prisma.store.findFirst({where:{id:{not:before.id},name:{equals:name,mode:"insensitive"}}});if(duplicate)return res.status(409).json({error:`A store named "${duplicate.name}" already exists.`});data.name=name;}if(req.body.active!==undefined)data.active=!!req.body.active;const store=await prisma.store.update({where:{id:before.id},data});await audit({actorId:req.user.id,action:"UPDATE",entityType:"Store",entityId:store.id,before,after:store});res.json(store);});
app.delete("/api/stores/:id",requireAdmin,async(req,res)=>{
 const store=await prisma.store.findUnique({where:{id:req.params.id}});
 if(!store)return res.status(404).json({error:"Store not found"});
 const docs=await prisma.documentRecord.findMany({where:{storeId:store.id},select:{id:true,storedName:true}});
 for(const d of docs){
  await prisma.auditLog.deleteMany({where:{documentId:d.id}});
  await prisma.approvalLog.deleteMany({where:{documentId:d.id}});
 }
 await prisma.documentRecord.deleteMany({where:{storeId:store.id}});
 await prisma.monthlySlipEntry.deleteMany({where:{storeId:store.id}});
 await prisma.user.updateMany({where:{storeId:store.id},data:{storeId:null,active:false}});
 await prisma.store.delete({where:{id:store.id}});
 for(const d of docs){if(!d.storedName)continue;if(d.storedName.startsWith("gdrive:")){await deleteDriveFile(d.storedName.slice(7));continue;}const f=path.join(uploadDir,path.basename(d.storedName));if(fs.existsSync(f))fs.unlink(f,()=>{});}
 await audit({actorId:req.user.id,action:"DELETE",entityType:"Store",entityId:store.id,before:{...store,deletedDocumentCount:docs.length}});
 res.json({ok:true,deletedDocuments:docs.length});
});
app.get("/api/users",requireAdmin,async(_q,res)=>{const users=await prisma.user.findMany({include:{store:true},orderBy:{createdAt:"desc"}});res.json(users.map(cleanUser));});
app.post("/api/users",requireAdmin,async(req,res)=>{const {name,email,password,role="STORE_MANAGER",storeId}=req.body||{};if(!name||!email||!password||String(password).length<10)return res.status(400).json({error:"Name, email and password (10+ characters) are required"});if(role==="STORE_MANAGER"&&!storeId)return res.status(400).json({error:"Select the store for this login"});const user=await prisma.user.create({data:{name,email:String(email).toLowerCase().trim(),passwordHash:await bcrypt.hash(password,12),role,storeId:role==="STORE_MANAGER"?storeId:null}});await audit({actorId:req.user.id,action:"CREATE",entityType:"User",entityId:user.id,after:cleanUser(user)});res.status(201).json(cleanUser(user));});
app.patch("/api/users/:id",requireAdmin,async(req,res)=>{
 const before=await prisma.user.findUnique({where:{id:req.params.id}});
 if(!before)return res.status(404).json({error:"User not found"});
 const data={};
 if(req.body.name!==undefined)data.name=String(req.body.name).trim();
 if(req.body.email!==undefined)data.email=String(req.body.email).toLowerCase().trim();
 if(req.body.role!==undefined){if(!["SUPER_ADMIN","STORE_MANAGER"].includes(req.body.role))return res.status(400).json({error:"Invalid user role"});data.role=req.body.role;}
 if(req.body.active!==undefined)data.active=!!req.body.active;
 if(req.body.storeId!==undefined)data.storeId=req.body.storeId||null;
 if(req.body.password!==undefined){if(String(req.body.password).length<10)return res.status(400).json({error:"Password must be at least 10 characters"});data.passwordHash=await bcrypt.hash(String(req.body.password),12);}
 const user=await prisma.user.update({where:{id:before.id},data});
 await audit({actorId:req.user.id,action:"UPDATE",entityType:"User",entityId:user.id,before:cleanUser(before),after:cleanUser(user)});
 res.json(cleanUser(user));
});
app.delete("/api/users/:id",requireAdmin,async(req,res)=>{
 if(req.params.id===req.user.id)return res.status(400).json({error:"You cannot delete your own admin account"});
 const before=await prisma.user.findUnique({where:{id:req.params.id}});
 if(!before)return res.status(404).json({error:"User not found"});
 await prisma.auditLog.updateMany({where:{actorId:before.id},data:{actorId:req.user.id}});
 await prisma.approvalLog.updateMany({where:{actorId:before.id},data:{actorId:req.user.id}});
 await prisma.documentRecord.updateMany({where:{uploadedById:before.id},data:{uploadedById:req.user.id}});
 await prisma.documentRecord.updateMany({where:{reviewedById:before.id},data:{reviewedById:null}});
 await prisma.user.delete({where:{id:before.id}});
 await audit({actorId:req.user.id,action:"DELETE",entityType:"User",entityId:before.id,before:cleanUser(before)});
 res.json({ok:true});
});
app.get("/api/documents",async(req,res)=>{const {storeId,from,to,date,month,year,q,kind}=req.query;const effective=storeScope(req.user,storeId);const where={...(effective?{storeId:effective}:{}),...(date?{documentDate:{gte:dateOnly(date),lt:new Date(dateOnly(date).getTime()+86400000)}}:{}),...(from||to?{documentDate:{...(from?{gte:dateOnly(from)}:{}),...(to?{lt:new Date(dateOnly(to).getTime()+86400000)}:{})}}:{}),...(q?{OR:[{title:{contains:String(q),mode:"insensitive"}},{originalName:{contains:String(q),mode:"insensitive"}},{store:{is:{name:{contains:String(q),mode:"insensitive"}}}}]}:{})};let docs=await prisma.documentRecord.findMany({where,include:{store:true,uploadedBy:{select:{id:true,name:true,email:true}}},orderBy:{createdAt:"desc"}});docs=docs.filter(d=>{const dt=d.documentDate||d.createdAt;return(!month||dt.getUTCMonth()+1===Number(month))&&(!year||dt.getUTCFullYear()===Number(year))&&(!kind||(kind==="DAILY_SHIFT_REPORT"?d.category==="DAILY_REPORT":d.category==="OTHER"&&d.title.startsWith("Other File")));});res.json(docs);});
app.post("/api/documents",uploadOne,async(req,res)=>{let driveFileId=null;try{if(!req.file)return res.status(400).json({error:"Choose a file to upload"});const body=req.body||{},kind=body.kind||"DAILY_SHIFT_REPORT";if(!["DAILY_SHIFT_REPORT","OTHER_FILE"].includes(kind))return res.status(400).json({error:"Invalid upload type"});const storeId=req.user.role==="SUPER_ADMIN"?body.storeId:req.user.storeId;if(!storeId)return res.status(400).json({error:"No store is assigned to this account"});if(req.user.role!=="SUPER_ADMIN"&&body.storeId&&body.storeId!==req.user.storeId)return res.status(403).json({error:"You can upload only to your assigned store"});const store=await prisma.store.findUnique({where:{id:storeId}});if(!store||!store.active)return res.status(404).json({error:"Active store not found"});const day=String(body.documentDate||dateString()).slice(0,10),docDate=dateOnly(day);if(kind==="DAILY_SHIFT_REPORT"){const exists=await prisma.documentRecord.findFirst({where:{storeId,category:"DAILY_REPORT",documentDate:docDate}});if(exists)return res.status(409).json({error:"Today's Daily Shift Report has already been uploaded for this store."});}const ext=path.extname(req.file.originalname).toLowerCase()||".jpg";let displayName=`${safeName(store.name)}_${day}${kind==="OTHER_FILE"?`_Other_${Date.now().toString().slice(-5)}`:""}${ext}`;const same=await prisma.documentRecord.findFirst({where:{storeId,originalName:displayName}});if(same)displayName=displayName.replace(ext,`_${crypto.randomBytes(2).toString("hex")}${ext}`);const driveFile=await uploadDriveFile(displayName,req.file.mimetype,req.file.buffer);driveFileId=driveFile.id;if(!driveFileId)throw new Error("Google Drive did not return a file ID");const doc=await prisma.documentRecord.create({data:{storeId,category:kind==="DAILY_SHIFT_REPORT"?"DAILY_REPORT":"OTHER",title:kind==="DAILY_SHIFT_REPORT"?"Daily Shift Report":"Other File",documentDate:docDate,uploadedById:req.user.id,originalName:displayName,storedName:`gdrive:${driveFileId}`,mimeType:req.file.mimetype,fileSize:req.file.size,status:"SUBMITTED"}});driveFileId=null;try{await audit({actorId:req.user.id,action:"UPLOAD",entityType:"DocumentRecord",entityId:doc.id,documentId:doc.id,after:doc});}catch(auditErr){console.error(`Upload audit log failed for document ${doc.id}: ${auditErr.message}`);}res.status(201).json(doc);}catch(e){if(driveFileId)await deleteDriveFile(driveFileId);res.status(e.status||400).json({error:e.message||"Upload failed"});}});
app.patch("/api/documents/:id",requireAdmin,async(req,res)=>{
 const before=await prisma.documentRecord.findUnique({where:{id:req.params.id}});
 if(!before)return res.status(404).json({error:"File record not found"});
 const allowed=["title","originalName","notes","referenceNumber","financialYear","currency","status"];
 const data={};
 for(const key of allowed)if(req.body[key]!==undefined)data[key]=String(req.body[key]).slice(0,key==="notes"?4000:255);
 if(req.body.amount!==undefined){const n=req.body.amount===""?null:Number(req.body.amount);if(n!==null&&!Number.isFinite(n))return res.status(400).json({error:"Amount must be a valid number"});data.amount=n;}
 if(req.body.documentDate!==undefined)data.documentDate=req.body.documentDate?dateOnly(req.body.documentDate):null;
 const doc=await prisma.documentRecord.update({where:{id:before.id},data});
 await audit({actorId:req.user.id,action:"UPDATE",entityType:"DocumentRecord",entityId:doc.id,documentId:doc.id,before,after:doc});
 res.json(doc);
});
app.get("/api/documents/:id/file",async(req,res)=>{const d=await prisma.documentRecord.findUnique({where:{id:req.params.id}});if(!d||!d.storedName)return res.status(404).json({error:"File not found"});if(req.user.role!=="SUPER_ADMIN"&&d.storeId!==req.user.storeId)return res.status(403).json({error:"Access denied"});if(d.storedName.startsWith("gdrive:"))return streamDriveFile(res,d);const p=path.join(uploadDir,path.basename(d.storedName));if(!fs.existsSync(p))return res.status(404).json({error:"File is missing from server storage"});res.download(p,d.originalName||"paper-work-file");});
app.delete("/api/documents/:id",requireAdmin,async(req,res)=>{const d=await prisma.documentRecord.findUnique({where:{id:req.params.id}});if(!d)return res.status(404).json({error:"File not found"});if(d.storedName&&d.storedName.startsWith("gdrive:")){try{await deleteDriveFile(d.storedName.slice(7),null,true);}catch{return res.status(502).json({error:"Could not delete file from Google Drive. The file record was not deleted."});}}await prisma.documentRecord.delete({where:{id:d.id}});if(d.storedName&&!d.storedName.startsWith("gdrive:")){const p=path.join(uploadDir,path.basename(d.storedName));if(fs.existsSync(p))fs.unlinkSync(p);}await audit({actorId:req.user.id,action:"DELETE",entityType:"DocumentRecord",entityId:d.id,before:d});res.json({ok:true});});
// Google Drive OAuth: refresh token is stored in the admin's MongoDB record after consent.
async function driveToken(){if(!process.env.GOOGLE_CLIENT_ID||!process.env.GOOGLE_CLIENT_SECRET)throw new Error("Google Drive is not configured. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to the backend environment.");const auth=await prisma.auditLog.findFirst({where:{entityType:"GoogleDrive",action:"TOKEN"},orderBy:{createdAt:"desc"}});const refreshToken=auth?.after?.refreshToken;if(!refreshToken)throw new Error("Connect your Google Drive first from the Admin dashboard.");const r=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:process.env.GOOGLE_CLIENT_ID,client_secret:process.env.GOOGLE_CLIENT_SECRET,refresh_token:refreshToken,grant_type:"refresh_token"})});const j=await r.json();if(!r.ok)throw new Error(j.error_description||"Google token refresh failed");return j.access_token;}
async function assertDriveFolderAccessible(token){
 const folderId=process.env.GOOGLE_DRIVE_FOLDER_ID;
 if(!folderId)return;
 const err=new Error("Google Drive folder is not found or not accessible by the connected Google account.");
 let r;
 try{r=await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?fields=id,mimeType,trashed`,{headers:{Authorization:`Bearer ${token}`}});}catch(e){throw new Error("Could not verify Google Drive folder");}
 if(r.status===404){console.error(`Google Drive folder check failed: folder ${folderId} not found or not accessible to the connected account`);throw err;}
 if(!r.ok){console.error(`Google Drive folder check failed (${r.status}) for folder ${folderId}`);throw new Error("Could not verify Google Drive folder");}
 const meta=await r.json();
 if(meta.trashed){console.error(`Google Drive folder check failed: folder ${folderId} is trashed`);throw err;}
 if(meta.mimeType&&meta.mimeType!=="application/vnd.google-apps.folder"){console.error(`Google Drive folder check failed: ${folderId} is not a folder`);throw new Error("Google Drive folder is invalid. Configure a valid folder ID for Google Drive uploads.");}
}
async function uploadDriveFile(filename,mimetype,buffer){
 const token=await driveToken();
 await assertDriveFolderAccessible(token);
 const boundary=`pw_${crypto.randomBytes(8).toString("hex")}`;
 const mime=mimetype||"application/octet-stream";
 const metadata={name:filename,mimeType:mime,...(process.env.GOOGLE_DRIVE_FOLDER_ID?{parents:[process.env.GOOGLE_DRIVE_FOLDER_ID]}:{})};
 const body=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`),buffer,Buffer.from(`\r\n--${boundary}--`)]);
 const response=await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType",{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":`multipart/related; boundary=${boundary}`},body});
 const file=await response.json();
 if(!response.ok||!file.id){
  console.error(`Google Drive upload failed (${response.status}): ${file.error?.message||"unknown error"}`);
  if(response.status===404)throw new Error("Google Drive folder is not found or not accessible by the connected Google account.");
  throw new Error(file.error?.message||"Could not upload file to Google Drive");
 }
 return file;
}
async function deleteDriveFile(fileId,token,strict=false){
 if(!fileId)return true;
 try{
  const t=token||await driveToken();
  const r=await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`,{method:"DELETE",headers:{Authorization:`Bearer ${t}`}});
  if(r.ok||r.status===404)return true;
  const msg=`Google Drive delete failed (${r.status}) for file ${fileId}`;
  if(strict)throw new Error(msg);
  console.error(msg);return false;
 }catch(e){if(strict)throw e;console.error(`Google Drive delete failed for file ${fileId}: ${e.message}`);return false;}
}
async function streamDriveFile(res,d){
 const fileId=d.storedName.slice("gdrive:".length);
 if(!fileId)return res.status(404).json({error:"File is missing from Google Drive"});
 let token;
 try{token=await driveToken();}catch(e){return res.status(400).json({error:e.message||"Google Drive is not available"});}
 try{
  const metaRes=await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,trashed`,{headers:{Authorization:`Bearer ${token}`}});
  if(metaRes.status===404)return res.status(404).json({error:"File is missing from Google Drive"});
  if(!metaRes.ok)return res.status(502).json({error:"Could not retrieve file from Google Drive"});
  const meta=await metaRes.json();
  if(meta.trashed)return res.status(404).json({error:"File is missing from Google Drive"});
  const dl=await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,{headers:{Authorization:`Bearer ${token}`}});
  if(dl.status===404)return res.status(404).json({error:"File is missing from Google Drive"});
  if(!dl.ok)return res.status(502).json({error:"Could not retrieve file from Google Drive"});
  const buffer=Buffer.from(await dl.arrayBuffer());
  const filename=d.originalName||meta.name||"paper-work-file";
  res.setHeader("Content-Type",d.mimeType||meta.mimeType||"application/octet-stream");
  res.setHeader("Content-Disposition",`attachment; filename="${String(filename).replace(/["\r\n]/g,"_")}"`);
  res.setHeader("Content-Length",buffer.length);
  return res.send(buffer);
 }catch(e){if(!res.headersSent)return res.status(502).json({error:"Could not retrieve file from Google Drive"});return res.end();}
}
app.get("/api/drive/status",requireAdmin,async(req,res)=>{const c=await prisma.auditLog.findFirst({where:{entityType:"GoogleDrive",action:"TOKEN"},orderBy:{createdAt:"desc"}});res.json({connected:!!c,folderConfigured:!!process.env.GOOGLE_DRIVE_FOLDER_ID,clientConfigured:!!process.env.GOOGLE_CLIENT_ID,email:c?.after?.email||null});});
app.get("/api/drive/connect",requireAdmin,async(req,res)=>{if(!process.env.GOOGLE_CLIENT_ID||!process.env.GOOGLE_CLIENT_SECRET)return res.status(400).json({error:"Configure GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI first."});const state=jwt.sign({adminId:req.user.id},process.env.JWT_SECRET,{expiresIn:"10m"});const u=new URL("https://accounts.google.com/o/oauth2/v2/auth");u.search=new URLSearchParams({client_id:process.env.GOOGLE_CLIENT_ID,redirect_uri:process.env.GOOGLE_REDIRECT_URI, response_type:"code",scope:"https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/spreadsheets email",access_type:"offline",prompt:"consent",state}).toString();res.json({url:u.toString()});});
app.get("/api/drive/callback",async(req,res)=>{try{const payload=jwt.verify(String(req.query.state||""),process.env.JWT_SECRET);const r=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({code:String(req.query.code||""),client_id:process.env.GOOGLE_CLIENT_ID,client_secret:process.env.GOOGLE_CLIENT_SECRET,redirect_uri:process.env.GOOGLE_REDIRECT_URI,grant_type:"authorization_code"})});const j=await r.json();if(!r.ok||!j.refresh_token)throw new Error(j.error_description||"Google did not return a refresh token. Revoke app access and connect again.");const info=await fetch("https://www.googleapis.com/oauth2/v2/userinfo",{headers:{Authorization:`Bearer ${j.access_token}`}}).then(x=>x.json());await audit({actorId:payload.adminId,action:"TOKEN",entityType:"GoogleDrive",entityId:"primary",after:{refreshToken:j.refresh_token,email:info.email}});res.send("<h2>Google Drive connected.</h2><p>You can close this tab and return to Paper Work.</p>");}catch(e){res.status(400).send(`<h2>Google Drive connection failed</h2><p>${String(e.message).replace(/[<>]/g,"")}</p>`);}});
// Create a new XLSX in Drive. This helper NEVER updates or replaces an existing file.
async function createDriveExcelFile(filename, buffer) {
 const token=await driveToken();
 const boundary=`pw_${crypto.randomBytes(8).toString("hex")}`;
 const metadata={
  name:filename,
  mimeType:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ...(process.env.GOOGLE_DRIVE_FOLDER_ID?{parents:[process.env.GOOGLE_DRIVE_FOLDER_ID]}:{})
 };
 const body=Buffer.concat([
  Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`),
  buffer,
  Buffer.from(`\r\n--${boundary}--`)
 ]);
 const response=await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink,mimeType",{
  method:"POST",
  headers:{Authorization:`Bearer ${token}`,"Content-Type":`multipart/related; boundary=${boundary}`},
  body
 });
 const file=await response.json();
 if(!response.ok||!file.id)throw new Error(file.error?.message||"Could not create workbook in Google Drive");
 return file;
}

const monthlyWorkbookLocks=new Map();
async function withMonthlyWorkbookLock(key,work){
 const previous=monthlyWorkbookLocks.get(key)||Promise.resolve();
 let release;
 const current=new Promise(resolve=>{release=resolve;});
 monthlyWorkbookLocks.set(key,current);
 await previous;
 try{return await work();}
 finally{release();if(monthlyWorkbookLocks.get(key)===current)monthlyWorkbookLocks.delete(key);}
}

async function driveGetFile(fileId,token){
 const response=await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,webViewLink,mimeType,trashed`,{
  headers:{Authorization:`Bearer ${token}`}
 });
 const file=await response.json();
 if(!response.ok)return null;
 return file;
}

async function findDriveExcelFiles(filename,token){
 const escaped=filename.replace(/\\/g,"\\\\").replace(/'/g,"\\'");
 const query=`name='${escaped}' and trashed=false${process.env.GOOGLE_DRIVE_FOLDER_ID?` and '${process.env.GOOGLE_DRIVE_FOLDER_ID}' in parents`:""}`;
 const url=`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&pageSize=1000&fields=files(id,name,webViewLink,mimeType,trashed)&supportsAllDrives=true&includeItemsFromAllDrives=true`;
 const response=await fetch(url,{headers:{Authorization:`Bearer ${token}`}});
 const result=await response.json();
 if(!response.ok)throw new Error(result.error?.message||"Could not search Google Drive for the monthly workbook");
 return (result.files||[]).filter(file=>file.mimeType==="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
}

async function buildMonthlyWorkbook(store,year,month){
 const start=new Date(Date.UTC(year,month-1,1)),end=new Date(Date.UTC(year,month,1));
 const docs=await prisma.documentRecord.findMany({where:{storeId:store.id,documentDate:{gte:start,lt:end}},orderBy:[{documentDate:"asc"},{createdAt:"asc"}]});
 const entries=await prisma.monthlySlipEntry.findMany({where:{storeId:store.id,year,month}});
 const entryKey=(date,name)=>`${date}|${name||""}`;
 const byKey=new Map(entries.map(e=>[entryKey(e.reportDate||"",e.fileName||""),e]));
 const docsByDate=new Map();
 for(const d of docs){const date=dateString(d.documentDate);if(!docsByDate.has(date))docsByDate.set(date,[]);docsByDate.get(date).push(d);}
 const rows=[];
 const days=new Date(Date.UTC(year,month,0)).getUTCDate();
 for(let day=1;day<=days;day++){
  const date=`${year}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
  const dayDocs=docsByDate.get(date)||[];
  const dayRows=dayDocs.length?dayDocs:[null];
  for(const d of dayRows){
   const name=d?.originalName||"",e=byKey.get(entryKey(date,name))||{};
   rows.push({"Report Date":date,"File Name":name,"File Type":d?(d.category==="DAILY_REPORT"?"Daily Shift Report":"Other File"):"","Upload Time (IST)":d?new Date(d.createdAt).toLocaleString("en-IN",{timeZone:"Asia/Kolkata"}):"","Slip Details":e.slipDetails||"","Amount":e.amount??"","Currency":e.currency||"USD","Notes":e.notes||"","Entered By":e.enteredBy||""});
  }
  // Keep saved manual rows that are not linked to an uploaded file.
  const manual=byKey.get(entryKey(date,""));
  if(manual&&dayDocs.length)rows.push({"Report Date":date,"File Name":"","File Type":"","Upload Time (IST)":"","Slip Details":manual.slipDetails||"","Amount":manual.amount??"","Currency":manual.currency||"USD","Notes":manual.notes||"","Entered By":manual.enteredBy||""});
 }
 const wb=XLSX.utils.book_new();
 XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([["PAPER WORK — MONTHLY STORE SLIP ENTRY"],["Store",store.name],["Month",`${String(month).padStart(2,"0")}/${year}`],["Instructions","Enter slip details for each date. Uploaded files appear on their report dates. Save in Paper Work to sync this workbook to Google Drive."]]),"Read Me");
 const ws=XLSX.utils.json_to_sheet(rows);
 ws["!cols"]=[{wch:15},{wch:42},{wch:22},{wch:24},{wch:45},{wch:16},{wch:12},{wch:35},{wch:20}];
 XLSX.utils.book_append_sheet(wb,ws,"Slip Entries");
 return {buffer:XLSX.write(wb,{type:"buffer",bookType:"xlsx"}),rows};
}

// Create or open one native Google Sheets workbook per store/month. The sheet is
// intentionally the editing surface: users enter data directly in Google Sheets.
app.get("/api/stores/:id/monthly-sheet",requireAdmin,async(req,res)=>{try{
 const y=Number(req.query.year),m=Number(req.query.month);
 if(!Number.isInteger(y)||y<2000||y>2100||!Number.isInteger(m)||m<1||m>12)return res.status(400).json({error:"Choose a valid month and year"});
 const store=await prisma.store.findUnique({where:{id:req.params.id}});if(!store)return res.status(404).json({error:"Store not found"});
 const entityId=`${store.id}:${y}:${m}`;
 let saved=await prisma.auditLog.findFirst({where:{entityType:"GoogleSheet",action:"MONTHLY_SHEET",entityId},orderBy:{createdAt:"desc"}});
 const token=await driveToken();
 if(saved?.after?.spreadsheetId){
  const check=await fetch(`https://www.googleapis.com/drive/v3/files/${saved.after.spreadsheetId}?fields=id,name,webViewLink,trashed`,{headers:{Authorization:`Bearer ${token}`}}).then(r=>r.json());
  if(!check.id||check.trashed) saved=null;
  else return res.json({url:check.webViewLink||`https://docs.google.com/spreadsheets/d/${check.id}/edit`,spreadsheetId:check.id,existing:true});
 }
 const filename=`${safeName(store.name)}_${y}-${String(m).padStart(2,"0")}`;
 const create=await fetch("https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink",{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({name:filename,mimeType:"application/vnd.google-apps.spreadsheet",...(process.env.GOOGLE_DRIVE_FOLDER_ID?{parents:[process.env.GOOGLE_DRIVE_FOLDER_ID]}:{})})});
 const file=await create.json();if(!create.ok)throw new Error(file.error?.message||"Could not create Google Sheet");
 const {rows}=await buildMonthlyWorkbook(store,y,m);
 const values=[["PAPER WORK — MONTHLY STORE WORKBOOK"],["Store",store.name],["Month",`${String(m).padStart(2,"0")}/${y}`],["Report Date","File Name","File Type","Upload Time (IST)","Slip Details","Amount","Currency","Notes","Entered By"],...rows.map(r=>[r["Report Date"],r["File Name"],r["File Type"],r["Upload Time (IST)"],r["Slip Details"],r.Amount,r.Currency,r.Notes,r["Entered By"]])];
 const update=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${file.id}/values/Sheet1!A1:I${values.length}?valueInputOption=USER_ENTERED`,{method:"PUT",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({majorDimension:"ROWS",values})});
 const result=await update.json();if(!update.ok)throw new Error(result.error?.message||"Sheet created but could not initialize its cells");
 await audit({actorId:req.user.id,action:"MONTHLY_SHEET",entityType:"GoogleSheet",entityId,after:{spreadsheetId:file.id,name:filename,storeId:store.id,year:y,month:m}});
 res.json({url:file.webViewLink||`https://docs.google.com/spreadsheets/d/${file.id}/edit`,spreadsheetId:file.id,existing:false});
 }catch(e){res.status(400).json({error:e.message||"Could not open monthly Google Sheet"});}});

app.get("/api/stores/:id/monthly-workbook",requireAdmin,async(req,res)=>{try{
 const y=Number(req.query.year),m=Number(req.query.month);if(!Number.isInteger(y)||m<1||m>12)return res.status(400).json({error:"Choose a valid month and year"});
 const store=await prisma.store.findUnique({where:{id:req.params.id}});if(!store)return res.status(404).json({error:"Store not found"});
 const {rows}=await buildMonthlyWorkbook(store,y,m);res.json({store:{id:store.id,name:store.name},year:y,month:m,rows});
 }catch(e){res.status(400).json({error:e.message||"Could not load workbook"});}});
app.put("/api/stores/:id/monthly-workbook",requireAdmin,async(req,res)=>{try{
 const y=Number(req.query.year),m=Number(req.query.month);if(!Number.isInteger(y)||m<1||m>12)return res.status(400).json({error:"Choose a valid month and year"});
 const store=await prisma.store.findUnique({where:{id:req.params.id}});if(!store)return res.status(404).json({error:"Store not found"});
 const rows=Array.isArray(req.body?.rows)?req.body.rows:[];if(rows.length>1000)return res.status(400).json({error:"Too many workbook rows"});
 for(const row of rows){
  const fileName=String(row.fileName||"").slice(0,255),reportDate=String(row.reportDate||"").slice(0,10);
  if(!/^\\d{4}-\\d{2}-\\d{2}$/.test(reportDate))continue;
  const data={storeId:store.id,year:y,month:m,reportDate,fileName,slipDetails:String(row.slipDetails||"").slice(0,4000),amount:row.amount===""||row.amount==null?null:Number(row.amount),currency:String(row.currency||"USD").slice(0,8),notes:String(row.notes||"").slice(0,4000),enteredBy:String(row.enteredBy||"").slice(0,150)};
  if(data.amount!==null&&!Number.isFinite(data.amount))return res.status(400).json({error:"Amount must be a valid number"});
  const old=await prisma.monthlySlipEntry.findFirst({where:{storeId:store.id,year:y,month:m,reportDate,fileName}});
  if(old)await prisma.monthlySlipEntry.update({where:{id:old.id},data});else await prisma.monthlySlipEntry.create({data});
 }
 const savedRows=await prisma.monthlySlipEntry.count({where:{storeId:store.id,year:y,month:m}});
 await audit({actorId:req.user.id,action:"UPDATE_WORKBOOK_DATA",entityType:"MonthlyWorkbook",entityId:`${store.id}:${y}:${m}`,after:{store:store.name,year:y,month:m,rows:savedRows,driveSynced:false}});
 res.json({saved:true,driveSynced:false,message:"Entries were saved to the database. The existing Google Drive Excel file was not regenerated or overwritten.",entries:savedRows});
 }catch(e){res.status(400).json({error:e.message||"Workbook could not be saved"});}});
app.get("/api/stores/:id/monthly.xlsx",requireAdmin,async(req,res)=>{try{
 const y=Number(req.query.year),m=Number(req.query.month);
 if(!Number.isInteger(y)||y<2000||y>2100||!Number.isInteger(m)||m<1||m>12)return res.status(400).json({error:"Choose a valid month and year"});
 const store=await prisma.store.findUnique({where:{id:req.params.id}});
 if(!store)return res.status(404).json({error:"Store not found"});
 const entityId=`${store.id}:${y}:${m}`;
 const filename=`${safeName(store.name)}_${y}-${String(m).padStart(2,"0")}.xlsx`;
 const result=await withMonthlyWorkbookLock(entityId,async()=>{
  const token=await driveToken();
  const saved=await prisma.auditLog.findFirst({
   where:{entityType:"MonthlyExcelWorkbook",action:"MONTHLY_XLSX",entityId},
   orderBy:{createdAt:"desc"}
  });

  // Once a workbook has been registered, opening it must never recreate it.
  if(saved?.after?.fileId){
   const existing=await driveGetFile(saved.after.fileId,token);
   if(!existing||existing.trashed){
    const error=new Error("The saved monthly Excel workbook is missing or was deleted from Google Drive. Restore it from Drive trash/version history; Paper Work did not create a replacement.");
    error.status=404;
    throw error;
   }
   return {file:existing,existing:true};
  }

  // Adopt one pre-existing matching workbook instead of replacing it.
  const matches=await findDriveExcelFiles(filename,token);
  if(matches.length>1){
   const error=new Error(`Found ${matches.length} Excel files named "${filename}" in the configured Drive folder. Resolve the duplicates manually; Paper Work will not guess or overwrite either file.`);
   error.status=409;
   throw error;
  }
  if(matches.length===1){
   const file=matches[0];
   await audit({actorId:req.user.id,action:"MONTHLY_XLSX",entityType:"MonthlyExcelWorkbook",entityId,after:{fileId:file.id,name:filename,storeId:store.id,year:y,month:m}});
   return {file,existing:true,adopted:true};
  }

  // First opening only: generate and create the workbook once.
  const {buffer,rows}=await buildMonthlyWorkbook(store,y,m);
  const file=await createDriveExcelFile(filename,buffer);
  await audit({actorId:req.user.id,action:"MONTHLY_XLSX",entityType:"MonthlyExcelWorkbook",entityId,after:{fileId:file.id,name:filename,storeId:store.id,year:y,month:m,initialRows:rows.length}});
  return {file,existing:false,entries:rows.length};
 });
 const file=result.file;
 res.json({
  saved:true,
  existing:result.existing,
  adopted:!!result.adopted,
  name:filename,
  webViewLink:file.webViewLink||`https://drive.google.com/file/d/${file.id}/view`,
  fileId:file.id,
  entries:result.entries??null
 });
 }catch(e){
  res.status(e.status||400).json({error:e.message||"Monthly workbook could not be opened"});
 }});
app.get("/api/audit",requireAdmin,async(_q,res)=>{const logs=await prisma.auditLog.findMany({orderBy:{createdAt:"desc"},take:300});res.json(logs);});
app.use((err,_req,res,_next)=>{console.error(err);res.status(500).json({error:"Unexpected server error"});});
app.listen(port,()=>console.log(`Paper Work API running on port ${port}`));
