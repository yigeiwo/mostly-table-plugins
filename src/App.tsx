import { useState, useEffect } from 'react'
import { bitable, FieldType, IAttachmentField, IFieldMeta } from '@lark-base-open/js-sdk'
import './App.css'

/**
 * 处理图片：缩放到指定像素尺寸并居中裁剪，转换为 jpg 格式
 */
const processImageWithPixel = (blob: Blob, targetWidth: number, targetHeight: number): Promise<Blob> => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('无法获取 canvas context'));
        return;
      }

      // 设置 canvas 为目标像素尺寸
      canvas.width = targetWidth;
      canvas.height = targetHeight;

      const imgWidth = img.width;
      const imgHeight = img.height;
      const targetRatio = targetWidth / targetHeight;
      const currentRatio = imgWidth / imgHeight;

      let sourceWidth, sourceHeight, sourceX, sourceY;

      if (currentRatio > targetRatio) {
        // 原图太宽，以高度为基准缩放，裁剪左右
        sourceHeight = imgHeight;
        sourceWidth = imgHeight * targetRatio;
        sourceX = (imgWidth - sourceWidth) / 2;
        sourceY = 0;
      } else {
        // 原图太高，以宽度为基准缩放，裁剪上下
        sourceWidth = imgWidth;
        sourceHeight = imgWidth / targetRatio;
        sourceX = 0;
        sourceY = (imgHeight - sourceHeight) / 2;
      }
      
      // 填充白色背景
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, targetWidth, targetHeight);
      
      // 将原图裁剪并绘制到目标尺寸的 canvas 上
      ctx.drawImage(img, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, targetWidth, targetHeight);
      
      canvas.toBlob((result) => {
        if (result) {
          resolve(result);
        } else {
          reject(new Error('Canvas 转换失败'));
        }
      }, 'image/jpeg', 0.9);
    };
    
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片加载失败，无法处理'));
    };
    
    img.src = url;
  });
};

function App() {
  const [tableName, setTableName] = useState<string>('Loading...')
  const [recordCount, setRecordCount] = useState<number>(0)
  const [isConverting, setIsConverting] = useState<boolean>(false)
  const [statusMsg, setStatusMsg] = useState<string>('')
  const [progress, setProgress] = useState<{ current: number; total: number }>({ current: 0, total: 0 })
  const [logs, setLogs] = useState<{ msg: string; type: 'info' | 'success' | 'error' }[]>([])
  
  // 字段列表状态
  const [attachmentFields, setAttachmentFields] = useState<IFieldMeta[]>([])
  
  // 选择状态
  const [selectedSourceFieldId, setSelectedSourceFieldId] = useState<string>('')
  const [selectedTargetFieldId, setSelectedTargetFieldId] = useState<string>('')
  const [targetWidth, setTargetWidth] = useState<number>(800)
  const [targetHeight, setTargetHeight] = useState<number>(800)

  useEffect(() => {
    const fetchData = async () => {
      try {
        const table = await bitable.base.getActiveTable()
        const name = await table.getName()
        setTableName(name)

        const recordList = await table.getRecordIdList()
        setRecordCount(recordList.length)

        // 获取所有附件字段 (17)
        const attachFields = await table.getFieldMetaListByType(FieldType.Attachment)
        setAttachmentFields(attachFields)
        
        if (attachFields.length > 0) {
          if (!selectedSourceFieldId) setSelectedSourceFieldId(attachFields[0].id)
          if (!selectedTargetFieldId) setSelectedTargetFieldId(attachFields[0].id)
        }
      } catch (error) {
        console.error('Failed to fetch fields:', error)
      }
    }

    fetchData()

    const off = bitable.base.onSelectionChange(async (event) => {
      if (event.data.tableId) {
        fetchData()
      }
    })

    return () => off()
  }, [selectedSourceFieldId, selectedTargetFieldId])

  const addLog = (msg: string, type: 'info' | 'success' | 'error' = 'info') => {
    setLogs(prev => [{ msg, type }, ...prev].slice(0, 50)) // 保留最近50条
  }

  const handleConvert = async () => {
    if (!selectedSourceFieldId || !selectedTargetFieldId) {
      setStatusMsg('请先选择源字段和目标字段')
      return
    }

    setIsConverting(true)
    setStatusMsg('正在初始化处理...')
    setLogs([]) // 清空旧日志

    try {
      const table = await bitable.base.getActiveTable()
      const recordIds = await table.getRecordIdList()
      const total = recordIds.length
      
      if (total === 0) {
        throw new Error('当前表格没有记录')
      }

      setProgress({ current: 0, total })
      
      const sourceField = await table.getField<IAttachmentField>(selectedSourceFieldId)
      const targetField = await table.getField<IAttachmentField>(selectedTargetFieldId)

      let successCount = 0
      let skipCount = 0
      let failCount = 0

      for (let i = 0; i < recordIds.length; i++) {
        const recordId = recordIds[i]
        setProgress({ current: i + 1, total })

        try {
          // 1. 获取源附件字段的值
          const attachmentList = await sourceField.getValue(recordId)
          
          if (!attachmentList || !Array.isArray(attachmentList) || attachmentList.length === 0) {
            addLog(`第 ${i+1} 行: 未找到附件`, 'info')
            skipCount++
            continue
          }

          addLog(`第 ${i+1} 行: 正在处理 ${attachmentList.length} 个附件...`, 'info')

          const processedFiles: File[] = []
          
          // 批量获取所有附件的 URL
          const tokens = attachmentList.map(a => a.token)
          const urls = await table.getCellAttachmentUrls(tokens, selectedSourceFieldId, recordId)

          for (let j = 0; j < attachmentList.length; j++) {
            const attachment = attachmentList[j]
            const url = urls[j]
            
            try {
              // 检查是否为图片 (简单判断扩展名或 mime 类型)
              const fileName = attachment.name || 'image.jpg'
              const isImage = /\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(fileName)
              
              if (!isImage) {
                addLog(`跳过非图片文件: ${fileName}`, 'info')
                continue
              }

              // 下载附件
              addLog(`正在下载附件: ${fileName}`, 'info')
              const response = await fetch(url)
              if (!response.ok) throw new Error(`下载失败: ${response.statusText}`)
              let blob = await response.blob()

              // 处理图片比例
              addLog(`正在调整像素: ${fileName}`, 'info')
              blob = await processImageWithPixel(blob, targetWidth, targetHeight)

              // 构造新文件名
              const baseName = fileName.includes('.') 
                ? fileName.substring(0, fileName.lastIndexOf('.'))
                : fileName;
              const newFileName = `${baseName}_${targetWidth}x${targetHeight}.jpg`

              processedFiles.push(new File([blob], newFileName, { type: 'image/jpeg' }))
              addLog(`已处理完成: ${newFileName}`, 'success')
            } catch (err: any) {
              addLog(`处理附件失败: ${attachment.name} - ${err.message}`, 'error')
            }
          }

          if (processedFiles.length > 0) {
            // 3. 直接使用 setValue 设置附件，SDK 会处理上传逻辑
            addLog(`正在上传 ${processedFiles.length} 个文件到目标字段...`, 'info')
            const res = await targetField.setValue(recordId, processedFiles)
            if (res) {
              addLog(`第 ${i+1} 行: 处理成功`, 'success')
              successCount++
            } else {
              addLog(`第 ${i+1} 行: 设置失败 (SDK 返回 false)`, 'error')
              failCount++
            }
          } else {
            addLog(`第 ${i+1} 行: 无有效图片可处理`, 'info')
            skipCount++
          }
          
        } catch (recordError: any) {
          console.error(`Error processing record ${recordId}:`, recordError)
          addLog(`第 ${i+1} 行: 失败 - ${recordError.message}`, 'error')
          failCount++
        }
      }

      setStatusMsg(`处理完成！成功: ${successCount}, 跳过: ${skipCount}, 失败: ${failCount}`)
    } catch (error: any) {
      console.error(error)
      setStatusMsg(`失败: ${error.message || '未知错误'}`)
    } finally {
      setIsConverting(false)
      setProgress({ current: 0, total: 0 })
    }
  }

  return (
    <div className="container">
      <h1>图片尺寸调整</h1>
      
      <div className="card">
        <h3>📊 表格信息</h3>
        <p>当前表: <strong>{tableName}</strong></p>
        <p>记录数: <strong>{recordCount}</strong></p>
      </div>

      <div className="card">
        <h3>🖼️ 调整图片像素</h3>
        <p className="desc">自动遍历全表，将图片缩放并裁剪至指定像素尺寸</p>
        
        <div className="form-group">
          <label>� 源附件字段</label>
          <select 
            value={selectedSourceFieldId} 
            onChange={(e) => setSelectedSourceFieldId(e.target.value)}
            disabled={isConverting}
            className="field-select"
          >
            {attachmentFields.length > 0 ? (
              attachmentFields.map(field => (
                <option key={field.id} value={field.id}>{field.name}</option>
              ))
            ) : (
              <option value="">未找到附件字段</option>
            )}
          </select>
        </div>

        <div className="form-group">
          <label>📁 目标附件字段</label>
          <select 
            value={selectedTargetFieldId} 
            onChange={(e) => setSelectedTargetFieldId(e.target.value)}
            disabled={isConverting}
            className="field-select"
          >
            {attachmentFields.length > 0 ? (
              attachmentFields.map(field => (
                <option key={field.id} value={field.id}>{field.name}</option>
              ))
            ) : (
              <option value="">未找到附件字段</option>
            )}
          </select>
        </div>

        <div className="form-group">
          <label>📐 目标像素 (宽 x 高)</label>
          <div className="ratio-inputs">
            <input 
              type="number" 
              value={targetWidth} 
              onChange={(e) => setTargetWidth(Number(e.target.value) || 1)}
              disabled={isConverting}
              placeholder="宽"
            />
            <span>x</span>
            <input 
              type="number" 
              value={targetHeight} 
              onChange={(e) => setTargetHeight(Number(e.target.value) || 1)}
              disabled={isConverting}
              placeholder="高"
            />
            <span style={{ fontSize: '0.8rem', color: '#8f959e', fontWeight: 'normal' }}>px</span>
          </div>
        </div>

        {isConverting && progress.total > 0 && (
          <div className="progress-container">
            <div className="progress-bar">
              <div 
                className="progress-fill" 
                style={{ width: `${(progress.current / progress.total) * 100}%` }}
              ></div>
            </div>
            <p className="progress-text">{progress.current} / {progress.total}</p>
          </div>
        )}

        <button 
          onClick={handleConvert} 
          disabled={isConverting || !selectedSourceFieldId || !selectedTargetFieldId}
          className={`convert-btn ${isConverting ? 'loading' : ''}`}
        >
          {isConverting ? '正在处理中...' : '开始调整比例'}
        </button>
        {statusMsg && <p className={`status-msg ${statusMsg.includes('完成') || statusMsg.includes('成功') ? 'success' : 'error'}`}>{statusMsg}</p>}

        {logs.length > 0 && (
          <div className="log-container">
            <h4>执行日志</h4>
            <div className="log-list">
              {logs.map((log, index) => (
                <div key={index} className={`log-item ${log.type}`}>
                  {log.msg}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <p className="footer">
        基于 @lark-base-open/js-sdk 开发
      </p>
    </div>
  )
}

export default App
